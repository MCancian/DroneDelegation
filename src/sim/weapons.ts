import type { World } from './world';
import type { MissileLaunchRequest, ScenarioHooks } from './scenario/scenario';
import type {
  Actor,
  Domain,
  PointDefenseMode,
  RadarContact,
  Vec2,
} from './types';
import { bearingTo, knotsToNmPerSec, rangeTo, velocityFrom } from './geo';
import { mulberry32, type Rng } from './rng';
import { WEAPONS_CONFIG, type WeaponsConfig } from './scenario/weaponsConfig';
import { executeCommand } from './commands';

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

export interface AscmFlight {
  kind: 'ascm';
  contactId: string;
  launcherId: string;
  weapon: string;
  ciwsEngaged: boolean;
}

export interface SamSalvo {
  id: string;
  targetId: string;
  targetDomain: Domain;
  interceptorIds: string[];
  launchedAtS: number;
  arriveAtS: number;
  actor: Actor;
}

export interface GunBurst {
  targetId: string;
  endsAtS: number;
  actor: Actor;
}

export interface WeaponsState {
  config: WeaponsConfig;
  rng: Rng;
  pointDefense: PointDefenseMode;
  chaffActiveUntilS: number;
  ascms: Record<string, AscmFlight>;
  salvos: SamSalvo[];
  gunBurst: GunBurst | null;
  nextMissileNumber: number;
  nextSalvoNumber: number;
  shipLost: boolean;
}

export function createWeaponsState(seed: number, config: WeaponsConfig = WEAPONS_CONFIG): WeaponsState {
  return {
    config,
    rng: mulberry32((seed ^ 0xc2b2ae35) >>> 0),
    pointDefense: 'manual',
    chaffActiveUntilS: -Infinity,
    ascms: {},
    salvos: [],
    gunBurst: null,
    nextMissileNumber: 1,
    nextSalvoNumber: 1,
    shipLost: false,
  };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type WeaponError = 'invalid_target' | 'out_of_range' | 'too_late' | 'no_inventory' | 'busy' | 'ship_lost';

export type WeaponResult = { ok: true } | { ok: false; error: WeaponError; message: string };

function fail(error: WeaponError, message: string): WeaponResult {
  return { ok: false, error, message };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function chaffActive(world: World): boolean {
  return world.time < world.weapons.chaffActiveUntilS;
}

export function interceptPoint(
  from: Vec2,
  speedKts: number,
  target: Vec2,
  targetCourseDeg: number,
  targetSpeedKts: number,
): { point: Vec2; timeS: number } {
  const s = knotsToNmPerSec(speedKts);
  const v = velocityFrom(targetCourseDeg, targetSpeedKts);

  const rx = target.x - from.x;
  const ry = target.y - from.y;

  const a = v.x * v.x + v.y * v.y - s * s;
  const b = 2 * (rx * v.x + ry * v.y);
  const c = rx * rx + ry * ry;

  let t: number | null = null;

  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) < 1e-12) {
      return { point: { x: target.x, y: target.y }, timeS: Math.hypot(rx, ry) / s };
    }
    const lt = -c / b;
    if (lt > 0) t = lt;
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) {
      return { point: { x: target.x, y: target.y }, timeS: Math.hypot(rx, ry) / s };
    }
    const sqrtD = Math.sqrt(discriminant);
    const t1 = (-b + sqrtD) / (2 * a);
    const t2 = (-b - sqrtD) / (2 * a);
    const candidates: number[] = [];
    if (t1 > 0) candidates.push(t1);
    if (t2 > 0) candidates.push(t2);
    if (candidates.length === 0) {
      return { point: { x: target.x, y: target.y }, timeS: Math.hypot(rx, ry) / s };
    }
    t = Math.min(...candidates);
  }

  if (t === null) {
    return { point: { x: target.x, y: target.y }, timeS: Math.hypot(rx, ry) / s };
  }

  return {
    point: { x: target.x + v.x * t, y: target.y + v.y * t },
    timeS: t,
  };
}

function nextTrackId(world: World, prefix: 'M'): string {
  const n = world.weapons.nextMissileNumber++;
  return `${prefix}-${String(n).padStart(2, '0')}`;
}

function destroyContact(world: World, contact: RadarContact, weapon: string, actor: Actor): void {
  contact.alive = false;
  world.logEvent('contact_destroyed', actor, {
    contactId: contact.id,
    trackId: contact.trackId,
    domain: contact.domain,
    truth: contact.truth,
    casualties: contact.personsAboard ?? 0,
    weapon,
  });
  if (contact.domain === 'missile' && world.weapons.ascms[contact.id]) {
    delete world.weapons.ascms[contact.id];
  }
}

function engageCiws(world: World, missileId: string, actor: Actor): void {
  const contact = world.contactById(missileId);
  if (!contact || !contact.alive) return;

  const ascm = world.weapons.ascms[missileId];
  if (!ascm) return;

  const cfg = world.weapons.config.ciws;
  world.ownShip.inventory.ciws -= cfg.roundsPerEngagement;
  ascm.ciwsEngaged = true;

  world.logEvent('weapon_fired', actor, {
    weapon: 'ciws',
    targetId: missileId,
    targetTrackId: contact.trackId,
  });

  const killed = world.weapons.rng.chance(cfg.pkPerMissile);
  if (killed) {
    destroyContact(world, contact, 'ciws', actor);
  }

  world.logEvent('weapon_result', actor, {
    weapon: 'ciws',
    targetId: missileId,
    killed,
  });
}

// ---------------------------------------------------------------------------
// Fire actions
// ---------------------------------------------------------------------------

export function fireSam(world: World, targetId: string, actor: Actor): WeaponResult {
  const ws = world.weapons;

  if (ws.shipLost) return fail('ship_lost', 'Ship is lost');

  const target = world.contactById(targetId);
  if (!target || !target.alive || target.ownMissile) return fail('invalid_target', `Target ${targetId} is not a valid target`);
  if (world.trackFor(targetId)?.detected !== true) return fail('invalid_target', `Target ${targetId} is not detected`);
  if (target.domain !== 'air' && target.domain !== 'missile') return fail('invalid_target', `Target ${targetId} domain '${target.domain}' is not valid for SAM`);

  const cfg = ws.config.sam;
  const range = rangeTo(world.ownShip.position, target.position);
  if (range < cfg.minRangeNm || range > cfg.maxRangeNm) {
    return fail('out_of_range', `Target at ${range.toFixed(1)} nm is outside SAM range [${cfg.minRangeNm}, ${cfg.maxRangeNm}] nm`);
  }

  if (world.ownShip.inventory.sam < cfg.salvoSize) {
    return fail('no_inventory', `Insufficient SAM inventory: ${world.ownShip.inventory.sam} < ${cfg.salvoSize}`);
  }

  world.ownShip.inventory.sam -= cfg.salvoSize;

  const ip = interceptPoint(
    world.ownShip.position,
    cfg.speedKts,
    target.position,
    target.courseDeg,
    target.speedKts,
  );

  const interceptorIds: string[] = [];
  for (let i = 0; i < cfg.salvoSize; i++) {
    const id = `sam-${ws.nextMissileNumber}`;
    const trackId = nextTrackId(world, 'M');
    interceptorIds.push(id);

    const interceptor: RadarContact = {
      id,
      trackId,
      domain: 'missile',
      truth: 'friendly',
      position: { x: world.ownShip.position.x, y: world.ownShip.position.y },
      courseDeg: bearingTo(world.ownShip.position, ip.point),
      speedKts: cfg.speedKts,
      altitudeFt: cfg.altitudeFt,
      classification: 'friendly',
      sensors: {
        iff: { kind: 'none' },
        ais: { kind: 'none' },
        esm: { kind: 'none' },
        visual: { kind: 'none' },
      },
      alive: true,
      history: [],
      ownMissile: true,
    };

    world.contacts.push(interceptor);
  }

  const salvoId = `salvo-${ws.nextSalvoNumber++}`;
  ws.salvos.push({
    id: salvoId,
    targetId,
    targetDomain: target.domain,
    interceptorIds,
    launchedAtS: world.time,
    arriveAtS: world.time + ip.timeS,
    actor,
  });

  world.logEvent('weapon_fired', actor, {
    weapon: 'sam',
    targetId,
    targetTrackId: target.trackId,
    rangeNm: range,
    salvoId,
    interceptorIds,
    flightTimeS: ip.timeS,
  });

  return { ok: true };
}

export function fireGun(world: World, targetId: string, actor: Actor): WeaponResult {
  const ws = world.weapons;

  if (ws.shipLost) return fail('ship_lost', 'Ship is lost');

  const target = world.contactById(targetId);
  if (!target || !target.alive || target.ownMissile) return fail('invalid_target', `Target ${targetId} is not a valid target`);
  if (world.trackFor(targetId)?.detected !== true) return fail('invalid_target', `Target ${targetId} is not detected`);
  if (target.domain !== 'surface') return fail('invalid_target', `Target ${targetId} domain '${target.domain}' is not valid for gun`);

  const cfg = ws.config.gun;
  const range = rangeTo(world.ownShip.position, target.position);
  if (range > cfg.maxRangeNm) {
    return fail('out_of_range', `Target at ${range.toFixed(1)} nm exceeds gun range ${cfg.maxRangeNm} nm`);
  }

  if (world.ownShip.inventory.gunBursts < 1) {
    return fail('no_inventory', 'No gun bursts remaining');
  }

  if (ws.gunBurst !== null) {
    return fail('busy', 'Gun is already engaged');
  }

  world.ownShip.inventory.gunBursts -= 1;
  ws.gunBurst = { targetId, endsAtS: world.time + cfg.burstS, actor };

  world.logEvent('weapon_fired', actor, {
    weapon: 'gun',
    targetId,
    targetTrackId: target.trackId,
    rangeNm: range,
  });

  return { ok: true };
}

export function fireCiws(world: World, targetId: string, actor: Actor): WeaponResult {
  const ws = world.weapons;

  if (ws.shipLost) return fail('ship_lost', 'Ship is lost');

  const target = world.contactById(targetId);
  if (!target || !target.alive || target.ownMissile) return fail('invalid_target', `Target ${targetId} is not a valid target`);
  if (world.trackFor(targetId)?.detected !== true) return fail('invalid_target', `Target ${targetId} is not detected`);
  if (target.domain !== 'missile') return fail('invalid_target', `Target ${targetId} domain '${target.domain}' is not valid for CIWS`);
  if (!ws.ascms[targetId]) return fail('invalid_target', `Target ${targetId} is not an inbound missile`);

  if (ws.ascms[targetId].ciwsEngaged) return fail('busy', `CIWS already engaged on ${targetId}`);

  const cfg = ws.config.ciws;
  const range = rangeTo(world.ownShip.position, target.position);
  if (range <= ws.config.ascm.arrivalRadiusNm) {
    return fail('too_late', 'Missile has entered the impact radius; too late for CIWS');
  }
  if (range > cfg.maxRangeNm) {
    return fail('out_of_range', `Target at ${range.toFixed(1)} nm exceeds CIWS range ${cfg.maxRangeNm} nm`);
  }

  if (world.ownShip.inventory.ciws < cfg.roundsPerEngagement) {
    return fail('no_inventory', `Insufficient CIWS rounds: ${world.ownShip.inventory.ciws} < ${cfg.roundsPerEngagement}`);
  }

  engageCiws(world, targetId, actor);
  return { ok: true };
}

export function deployChaff(world: World, actor: Actor): WeaponResult {
  const ws = world.weapons;

  if (ws.shipLost) return fail('ship_lost', 'Ship is lost');

  if (world.ownShip.inventory.chaff < 1) {
    return fail('no_inventory', 'No chaff remaining');
  }

  world.ownShip.inventory.chaff -= 1;
  ws.chaffActiveUntilS = world.time + ws.config.chaff.durationS;

  world.logEvent('chaff_deployed', actor, {
    activeUntilS: ws.chaffActiveUntilS,
    remaining: world.ownShip.inventory.chaff,
  });

  return { ok: true };
}

export function setPointDefense(world: World, mode: PointDefenseMode, actor: Actor): void {
  world.weapons.pointDefense = mode;
  world.logEvent('point_defense_mode', actor, { mode });
}

// ---------------------------------------------------------------------------
// Scenario hook: launch enemy ASCMs
// ---------------------------------------------------------------------------

export function launchAscms(world: World, req: MissileLaunchRequest): void {
  const ws = world.weapons;
  const cfg = ws.config.ascm;

  for (let i = 0; i < req.count; i++) {
    const id = `ascm-${ws.nextMissileNumber}`;
    const trackId = nextTrackId(world, 'M');

    const contact: RadarContact = {
      id,
      trackId,
      domain: 'missile',
      truth: 'hostile',
      position: { x: req.position.x, y: req.position.y },
      courseDeg: bearingTo(req.position, world.ownShip.position),
      speedKts: req.speedKts,
      altitudeFt: req.altitudeFt,
      classification: 'hostile',
      sensors: {
        iff: { kind: 'none' },
        ais: { kind: 'none' },
        esm: { kind: 'none' },
        visual: { kind: 'none' },
      },
      alive: true,
      history: [],
      motion: {
        behavior: {
          kind: 'closeOnOwnship',
          speedKts: req.speedKts,
          mode: 'pure',
          turnRateDegPerSec: cfg.turnRateDegPerSec,
        },
        schedule: [],
      },
    };

    world.contacts.push(contact);

    ws.ascms[id] = {
      kind: 'ascm',
      contactId: id,
      launcherId: req.launcherId,
      weapon: req.weapon,
      ciwsEngaged: false,
    };

    world.logEvent('ascm_launched', 'scenario', {
      missileId: id,
      trackId,
      launcherId: req.launcherId,
      weapon: req.weapon,
    });
  }
}

export const WEAPONS_HOOKS: ScenarioHooks = { launchMissiles: launchAscms };

// ---------------------------------------------------------------------------
// Step: called by World.step after kinematics
// ---------------------------------------------------------------------------

export function stepWeapons(world: World, _dtS: number): void {
  const ws = world.weapons;
  const cfg = ws.config;

  // 1. Auto chaff
  if (ws.pointDefense === 'auto' && !chaffActive(world) && world.ownShip.inventory.chaff >= 1) {
    for (const ascmId of Object.keys(ws.ascms)) {
      const ascm = ws.ascms[ascmId];
      if (!ascm) continue;
      const contact = world.contactById(ascmId);
      if (!contact || !contact.alive) continue;
      if (world.trackFor(ascmId)?.detected !== true) continue;

      const rangeNm = rangeTo(world.ownShip.position, contact.position);
      // Defenses cannot act after a missile has crossed the impact threshold;
      // stepWeapons resolves impact later in this step.
      if (rangeNm <= cfg.ascm.arrivalRadiusNm) continue;
      const speedNmPerSec = contact.speedKts / 3600;
      if (speedNmPerSec <= 0) continue;
      const timeToImpact = rangeNm / speedNmPerSec;

      if (timeToImpact <= cfg.chaff.durationS) {
        executeCommand(world, { action: 'chaff' }, 'crew-auto');
        break;
      }
    }
  }

  // 2. Auto CIWS
  if (ws.pointDefense === 'auto') {
    for (const ascmId of Object.keys(ws.ascms)) {
      const ascm = ws.ascms[ascmId];
      if (!ascm || ascm.ciwsEngaged) continue;
      const contact = world.contactById(ascmId);
      if (!contact || !contact.alive) continue;
      if (world.trackFor(ascmId)?.detected !== true) continue;

      const rangeNm = rangeTo(world.ownShip.position, contact.position);
      if (rangeNm <= cfg.ascm.arrivalRadiusNm) continue;
      if (rangeNm > cfg.ciws.maxRangeNm) continue;
      if (world.ownShip.inventory.ciws < cfg.ciws.roundsPerEngagement) continue;

      executeCommand(world, { action: 'ciws', target: ascmId }, 'crew-auto');
    }
  }

  // 3. SAM salvos arriving
  const arrivedSalvos: SamSalvo[] = [];
  const remainingSalvos: SamSalvo[] = [];
  for (const salvo of ws.salvos) {
    if (world.time >= salvo.arriveAtS - 1e-9) {
      arrivedSalvos.push(salvo);
    } else {
      remainingSalvos.push(salvo);
    }
  }
  ws.salvos = remainingSalvos;

  for (const salvo of arrivedSalvos) {
    // Deactivate interceptors
    for (const interceptorId of salvo.interceptorIds) {
      const interceptor = world.contactById(interceptorId);
      if (interceptor) {
        interceptor.alive = false;
      }
    }

    const target = world.contactById(salvo.targetId);
    if (!target || !target.alive) {
      world.logEvent('weapon_result', salvo.actor, {
        weapon: 'sam',
        salvoId: salvo.id,
        targetId: salvo.targetId,
        killed: false,
      });
      continue;
    }

    let killed = false;
    if (salvo.targetDomain === 'missile') {
      for (let i = 0; i < salvo.interceptorIds.length; i++) {
        if (ws.rng.chance(cfg.sam.pkPerMissileVsAscm)) {
          killed = true;
          break;
        }
      }
    } else {
      killed = ws.rng.chance(cfg.sam.pkSalvoVsAircraft);
    }

    if (killed) {
      destroyContact(world, target, 'sam', salvo.actor);
    }

    world.logEvent('weapon_result', salvo.actor, {
      weapon: 'sam',
      salvoId: salvo.id,
      targetId: salvo.targetId,
      killed,
    });
  }

  // 4. Gun burst ending
  if (ws.gunBurst !== null && world.time >= ws.gunBurst.endsAtS - 1e-9) {
    const burst = ws.gunBurst;
    ws.gunBurst = null;

    const target = world.contactById(burst.targetId);
    if (target && target.alive) {
      destroyContact(world, target, 'gun', burst.actor);
      world.logEvent('weapon_result', burst.actor, {
        weapon: 'gun',
        targetId: burst.targetId,
        killed: true,
      });
    }
  }

  // 5. ASCM arrivals
  const arrivedAscmIds: string[] = [];
  for (const ascmId of Object.keys(ws.ascms)) {
    const ascm = ws.ascms[ascmId];
    if (!ascm) continue;
    const contact = world.contactById(ascmId);
    if (!contact || !contact.alive) continue;

    const rangeNm = rangeTo(world.ownShip.position, contact.position);
    if (rangeNm <= cfg.ascm.arrivalRadiusNm) {
      arrivedAscmIds.push(ascmId);
    }
  }

  for (const ascmId of arrivedAscmIds) {
    const ascm = ws.ascms[ascmId];
    if (!ascm) continue;
    const contact = world.contactById(ascmId);
    if (!contact || !contact.alive) continue;

    contact.alive = false;
    delete ws.ascms[ascmId];

    const isChaff = chaffActive(world);
    const p = isChaff ? cfg.ascm.pHitChaff : cfg.ascm.pHit;
    const hit = ws.rng.chance(p);

    if (hit) {
      world.ownShip.hullPct = Math.max(0, world.ownShip.hullPct - cfg.ascm.damagePct);
    }

    world.logEvent('missile_impact', 'scenario', {
      missileId: ascmId,
      launcherId: ascm.launcherId,
      hit,
      chaffActive: isChaff,
      hullPct: world.ownShip.hullPct,
    });

    if (world.ownShip.hullPct <= 0 && !ws.shipLost) {
      ws.shipLost = true;
      world.logEvent('ship_lost', 'scenario', { hullPct: world.ownShip.hullPct });
    }
  }
}
