import type { World } from '../world';
import type { RadarContact, Vec2, IffInfo, AisInfo, EsmInfo, VisualInfo } from '../types';
import { bearingTo, rangeTo, cpa, closingSpeed, velocityFrom, angleDiff } from '../geo';
import type { CrewStation, CrewPriority } from './scenario';
import { executeCommand } from '../commands';

export interface CrewReport {
  station: CrewStation;
  priority: CrewPriority;
  text: string;
  contactId?: string;
  trackId?: string;
}

interface SafeSnap {
  id: string; trackId: string; domain: string; position: Vec2;
  courseDeg: number; speedKts: number; altitudeFt: number;
  sensors: RadarContact['sensors']; ownMissile?: boolean;
}

interface MissileAssoc { missileId: string; launcherId: string; }

interface AnnouncedSensors {
  iff: string;
  ais: string;
  esm: string;
  visual: string;
}

interface CrewState {
  prev: Map<string, SafeSnap>;
  known: Set<string>;
  eventCursor: number;
  cooldowns: Map<string, number>;
  reportedMissiles: Set<string>;
  missileToLauncher: Map<string, string>;
  pendingHostile: MissileAssoc[];
  knownTrackIds: Map<string, string>;
  announced: Map<string, AnnouncedSensors>;
  pendingEwReserve: Set<string>;
}

const stateMap = new WeakMap<World, CrewState>();

function getState(world: World): CrewState {
  let s = stateMap.get(world);
  if (!s) {
    s = { prev: new Map(), known: new Set(), eventCursor: 0, cooldowns: new Map(),
      reportedMissiles: new Set(), missileToLauncher: new Map(), pendingHostile: [],
      knownTrackIds: new Map(), announced: new Map(), pendingEwReserve: new Set() };
    stateMap.set(world, s);
  }
  return s;
}

function emit(world: World, r: CrewReport): void {
  world.logEvent('crew-report', 'crew-auto', r);
}

function cdOk(st: CrewState, key: string, t: number, cd: number): boolean {
  const last = st.cooldowns.get(key);
  if (last !== undefined && t - last < cd) return false;
  st.cooldowns.set(key, t);
  return true;
}

function snap(t: RadarContact): SafeSnap {
  return { id: t.id, trackId: t.trackId, domain: t.domain,
    position: { x: t.position.x, y: t.position.y },
    courseDeg: t.courseDeg, speedKts: t.speedKts, altitudeFt: t.altitudeFt,
    sensors: structuredClone(t.sensors), ownMissile: t.ownMissile };
}

function defaultSnap(t: RadarContact): SafeSnap {
  return { id: t.id, trackId: t.trackId, domain: t.domain,
    position: { x: t.position.x, y: t.position.y },
    courseDeg: t.courseDeg, speedKts: t.speedKts, altitudeFt: t.altitudeFt,
    sensors: { iff: { kind: 'none' }, ais: { kind: 'none' }, esm: { kind: 'none' }, visual: { kind: 'none' } },
    ownMissile: t.ownMissile };
}

function fmtBrg(b: number): string { return String(Math.round(b) % 360).padStart(3, '0'); }
function fmtRng(r: number): string { return r.toFixed(1); }

function stationForDomain(domain: string): CrewStation {
  return domain === 'surface' ? 'SWC' : 'TAO-Air';
}

function trackLabel(world: World, st: CrewState, contactId: string): string {
  const tr = world.trackFor(contactId);
  if (tr) { st.knownTrackIds.set(contactId, tr.trackId); return tr.trackId; }
  const known = st.knownTrackIds.get(contactId);
  if (known) return known;
  return 'unknown track';
}

function iffSig(iff: IffInfo): string {
  if (iff.kind === 'none') return 'none';
  if (iff.kind === 'mode3') return `mode3:${iff.code}`;
  return 'mode4';
}
function aisSig(ais: AisInfo): string {
  if (ais.kind === 'none') return 'none';
  return `vessel:${ais.name}:${ais.vesselType}`;
}
function esmSig(esm: EsmInfo): string {
  if (esm.kind === 'none') return 'none';
  return `emitter:${esm.emitterType}`;
}
function visSig(vis: VisualInfo): string {
  if (vis.kind === 'none') return 'none';
  return `identified:${vis.description}`;
}

function getAnnounced(st: CrewState, id: string): AnnouncedSensors {
  let a = st.announced.get(id);
  if (!a) {
    a = { iff: 'none', ais: 'none', esm: 'none', visual: 'none' };
    st.announced.set(id, a);
  }
  return a;
}

function processEvents(world: World, st: CrewState): void {
  const evts = world.events;
  while (st.eventCursor < evts.length) {
    const ev = evts[st.eventCursor]; st.eventCursor++;
    const p = ev.payload as Record<string, unknown>;
    const t = ev.t;

    if (ev.type === 'crew-report') {
      const station = p.station as string;
      const contactId = p.contactId as string | undefined;
      if (station === 'Lookouts' && contactId) st.cooldowns.set(`Lookouts:${contactId}:visEta`, t);
      if (station === 'Radio' && contactId) st.cooldowns.set(`Radio:${contactId}:civil`, t);
      if (station === 'EW' && contactId) {
        const contact = world.contactById(contactId);
        if (contact && contact.alive) {
          const track = world.trackFor(contactId);
          if (track && track.detected) {
            const esm = contact.sensors.esm;
            const text = (p.text as string) ?? '';
            if (esm.kind === 'emitter') {
              if (text.includes(esm.emitterType)) {
                const ann = getAnnounced(st, contactId);
                ann.esm = esmSig(esm);
              }
            } else {
              if (text.includes('emitting')) {
                st.pendingEwReserve.add(contactId);
              }
            }
          }
        }
      }
      continue;
    }

    if (ev.type === 'ascm_launched') {
      const missileId = (p.missileId as string) ?? '';
      const launcherId = (p.launcherId as string) ?? '';
      if (missileId && launcherId) {
        st.missileToLauncher.set(missileId, launcherId);
        st.pendingHostile.push({ missileId, launcherId });
      }
      continue;
    }

    if (ev.type === 'missile-launch') {
      continue;
    }

    if (ev.type === 'command_response') {
      const action = p.action as string;
      const target = p.target as string;
      const trackId = p.trackId as string;
      const outcome = p.outcome as string;
      const iff = p.iff as RadarContact['sensors']['iff'] | undefined;

      if (action === 'iff_challenge') {
        if (outcome === 'iff' && iff) {
          if (iff.kind === 'mode4') emit(world, { station: 'TAO-Air', priority: 'routine', text: `TAO-Air: ${trackId} Mode 4 valid, friendly.`, contactId: target, trackId });
          else if (iff.kind === 'mode3') emit(world, { station: 'TAO-Air', priority: 'routine', text: `TAO-Air: ${trackId} squawking Mode 3 ${iff.code}.`, contactId: target, trackId });
          else emit(world, { station: 'TAO-Air', priority: 'priority', text: `TAO-Air: ${trackId} no IFF response.`, contactId: target, trackId });
          const ann = getAnnounced(st, target);
          ann.iff = iffSig(iff);
        }
      } else if (action === 'radio_warning') {
        if (outcome === 'ignored') emit(world, { station: 'Radio', priority: 'priority', text: `Radio: ${trackId} ignored warning.`, contactId: target, trackId });
        else emit(world, { station: 'Radio', priority: 'routine', text: `Radio: ${trackId} acknowledged warning.`, contactId: target, trackId });
      } else if (action === 'hail') {
        if (outcome === 'ignored') emit(world, { station: 'Radio', priority: 'priority', text: `Radio: ${trackId} ignored hail.`, contactId: target, trackId });
        else emit(world, { station: 'Radio', priority: 'routine', text: `Radio: ${trackId} answered hail.`, contactId: target, trackId });
      } else if (action === 'illuminate') {
        if (outcome === 'ignored') emit(world, { station: 'TAO-Air', priority: 'priority', text: `TAO-Air: ${trackId} ignored illumination.`, contactId: target, trackId });
        else emit(world, { station: 'TAO-Air', priority: 'routine', text: `TAO-Air: ${trackId} turned away from illumination.`, contactId: target, trackId });
      } else if (action === 'warning_shots') {
        if (outcome === 'ignored') emit(world, { station: 'SWC', priority: 'priority', text: `SWC: ${trackId} ignored warning shots.`, contactId: target, trackId });
        else emit(world, { station: 'SWC', priority: 'routine', text: `SWC: ${trackId} complied with warning shots.`, contactId: target, trackId });
      }
      continue;
    }

    if (ev.type === 'weapon_fired') {
      const weapon = p.weapon as string;
      const targetTrackId = p.targetTrackId as string;
      const targetId = p.targetId as string;
      if (weapon === 'sam') emit(world, { station: 'TAO-Air', priority: 'routine', text: `TAO-Air: Birds away, SAM on ${targetTrackId}.`, contactId: targetId, trackId: targetTrackId });
      else if (weapon === 'gun') emit(world, { station: 'SWC', priority: 'routine', text: `SWC: Gun engaged on ${targetTrackId}.`, contactId: targetId, trackId: targetTrackId });
      else if (weapon === 'ciws') emit(world, { station: 'TAO-Air', priority: 'routine', text: `TAO-Air: CIWS engaged on ${targetTrackId}.`, contactId: targetId, trackId: targetTrackId });
      continue;
    }

    if (ev.type === 'weapon_result') {
      const weapon = p.weapon as string;
      const targetId = p.targetId as string;
      const killed = p.killed as boolean;
      const tid = trackLabel(world, st, targetId);
      const station: CrewStation = weapon === 'gun' ? 'SWC' : 'TAO-Air';
      if (killed) emit(world, { station, priority: 'routine', text: `${station}: Splash one, ${tid} destroyed.`, contactId: targetId, trackId: tid });
      else emit(world, { station, priority: 'priority', text: `${station}: Miss on ${tid}.`, contactId: targetId, trackId: tid });
      continue;
    }

    if (ev.type === 'chaff_deployed') {
      emit(world, { station: 'EW', priority: 'routine', text: 'EW: Chaff deployed.' });
      continue;
    }

    if (ev.type === 'missile_impact') {
      const hit = p.hit as boolean;
      const hullPct = p.hullPct as number;
      if (hit) emit(world, { station: 'Bridge', priority: 'flash', text: `Bridge: Missile impact! Hull ${Math.round(hullPct)}%.` });
      else emit(world, { station: 'Bridge', priority: 'routine', text: 'Bridge: Missile missed, no damage.' });
      continue;
    }

    if (ev.type === 'ship_lost') {
      emit(world, { station: 'Bridge', priority: 'flash', text: 'Bridge: Ship lost.' });
      continue;
    }
  }
}

function processTrack(world: World, st: CrewState, track: RadarContact, t: number): void {
  const prev = st.prev.get(track.id) ?? defaultSnap(track);
  const ownPos = world.ownShip.position;
  const rng = rangeTo(ownPos, track.position);
  const brg = bearingTo(ownPos, track.position);
  const firstSeen = !st.known.has(track.id);

  if (firstSeen) {
    st.known.add(track.id);
    st.knownTrackIds.set(track.id, track.trackId);
    if (track.domain === 'air') {
      emit(world, { station: 'CIC', priority: 'routine', text: `CIC: New air track ${track.trackId}, bearing ${fmtBrg(brg)}, range ${fmtRng(rng)} nm, alt ${Math.round(track.altitudeFt)} ft, speed ${Math.round(track.speedKts)} kts.`, contactId: track.id, trackId: track.trackId });
    } else if (track.domain === 'surface') {
      emit(world, { station: 'SWC', priority: 'routine', text: `SWC: New surface track ${track.trackId}, bearing ${fmtBrg(brg)}, range ${fmtRng(rng)} nm, speed ${Math.round(track.speedKts)} kts.`, contactId: track.id, trackId: track.trackId });
    }
  }

  if (!firstSeen) {
    const speedDelta = Math.abs(track.speedKts - prev.speedKts);
    if (speedDelta > 10) {
      const stn = stationForDomain(track.domain);
      emit(world, { station: stn, priority: 'priority', text: `${stn}: ${track.trackId} speed change ${Math.round(prev.speedKts)} to ${Math.round(track.speedKts)} kts.`, contactId: track.id, trackId: track.trackId });
    }

    const ownBrg = bearingTo(track.position, ownPos);
    const prevErr = Math.abs(angleDiff(prev.courseDeg, ownBrg));
    const nowErr = Math.abs(angleDiff(track.courseDeg, ownBrg));
    const courseChange = Math.abs(angleDiff(prev.courseDeg, track.courseDeg));
    if (prevErr > 45 && nowErr <= 30 && courseChange > 20) {
      const stn = stationForDomain(track.domain);
      emit(world, { station: stn, priority: 'priority', text: `${stn}: ${track.trackId} turning toward us, course ${fmtBrg(track.courseDeg)}.`, contactId: track.id, trackId: track.trackId });
    }
  }

  const ownVel = velocityFrom(world.ownShip.courseDeg, world.ownShip.speedKts);
  const tgtVel = velocityFrom(track.courseDeg, track.speedKts);
  const cpaRes = cpa(ownPos, ownVel, track.position, tgtVel);
  const cs = closingSpeed(ownPos, ownVel, track.position, tgtVel);
  if (cpaRes.tCpaSec > 0 && cs > 0 && cpaRes.rangeNm < 2) {
    const key = `cpa:${track.id}`;
    if (cdOk(st, key, t, 30)) {
      const stn = stationForDomain(track.domain);
      emit(world, { station: stn, priority: 'priority', text: `${stn}: ${track.trackId} closing, CPA ${cpaRes.rangeNm.toFixed(1)} nm in ${Math.round(cpaRes.tCpaSec)}s.`, contactId: track.id, trackId: track.trackId });
    }
  }

  if (track.domain === 'surface' && track.speedKts > 30 && track.sensors.ais.kind === 'none'
    && track.sensors.visual.kind === 'none' && cs > 0 && rng > world.sensorConfig.visualRangeNm) {
    const key = `Lookouts:${track.id}:visEta`;
    if (cdOk(st, key, t, 30)) {
      const visR = world.sensorConfig.visualRangeNm;
      const etaSec = (rng - visR) / (cs / 3600);
      if (etaSec > 0) {
        const totalSec = Math.round(etaSec);
        const etaMin = Math.floor(totalSec / 60);
        const etaS = totalSec % 60;
        emit(world, { station: 'Lookouts', priority: 'routine', text: `Lookouts: no visual on ${track.trackId} in haze; est. visual at ${visR} nm in ${etaMin}:${String(etaS).padStart(2, '0')}.`, contactId: track.id, trackId: track.trackId });
      }
    }
  }

  processSensorInfo(world, st, track);

  processClassification(world, track);
}

function processSensorInfo(world: World, st: CrewState, track: RadarContact): void {
  const cur = track.sensors;
  const ann = getAnnounced(st, track.id);

  const curIff = iffSig(cur.iff);
  if (curIff !== ann.iff) {
    if (cur.iff.kind !== 'none') {
      if (cur.iff.kind === 'mode4') emit(world, { station: 'TAO-Air', priority: 'routine', text: `TAO-Air: ${track.trackId} Mode 4 valid.`, contactId: track.id, trackId: track.trackId });
      else if (cur.iff.kind === 'mode3') emit(world, { station: 'TAO-Air', priority: 'routine', text: `TAO-Air: ${track.trackId} Mode 3 ${cur.iff.code}.`, contactId: track.id, trackId: track.trackId });
      ann.iff = curIff;
    } else {
      ann.iff = 'none';
    }
  }

  const curAis = aisSig(cur.ais);
  if (curAis !== ann.ais) {
    if (cur.ais.kind === 'vessel') {
      emit(world, { station: 'SWC', priority: 'routine', text: `SWC: ${track.trackId} AIS ${cur.ais.name} (${cur.ais.vesselType}).`, contactId: track.id, trackId: track.trackId });
      ann.ais = curAis;
    } else {
      ann.ais = 'none';
    }
  }

  const curEsm = esmSig(cur.esm);
  if (curEsm !== ann.esm) {
    if (cur.esm.kind === 'emitter') {
      if (st.pendingEwReserve.has(track.id)) {
        st.pendingEwReserve.delete(track.id);
        ann.esm = curEsm;
      } else {
        emit(world, { station: 'EW', priority: 'priority', text: `EW: ${track.trackId} emitting ${cur.esm.emitterType}.`, contactId: track.id, trackId: track.trackId });
        ann.esm = curEsm;
      }
    } else {
      ann.esm = 'none';
    }
  }

  const curVis = visSig(cur.visual);
  if (curVis !== ann.visual) {
    if (cur.visual.kind === 'identified') {
      emit(world, { station: 'Lookouts', priority: 'priority', text: `Lookouts: ${track.trackId} identified as ${cur.visual.description}.`, contactId: track.id, trackId: track.trackId });
      ann.visual = curVis;
    } else {
      ann.visual = 'none';
    }
  }
}

function processClassification(world: World, track: RadarContact): void {
  if (track.classification !== 'unknown') return;
  if (track.sensors.ais.kind === 'vessel') {
    executeCommand(world, { action: 'classify', target: track.id, classification: 'neutral' }, 'crew-auto');
  } else if (track.sensors.iff.kind === 'mode4') {
    executeCommand(world, { action: 'classify', target: track.id, classification: 'friendly' }, 'crew-auto');
  }
}

function processMissileFlash(world: World, st: CrewState, tracks: RadarContact[], t: number): void {
  const newMissiles: RadarContact[] = [];
  for (const tr of tracks) {
    if (tr.domain !== 'missile' || tr.ownMissile) continue;
    if (st.reportedMissiles.has(tr.id)) continue;
    newMissiles.push(tr);
  }

  if (newMissiles.length > 0) {
    const groups: { bearing: number; tracks: RadarContact[] }[] = [];
    for (const m of newMissiles) {
      const brg = bearingTo(world.ownShip.position, m.position);
      let found = false;
      for (const g of groups) {
        if (Math.abs(angleDiff(g.bearing, brg)) <= 10) { g.tracks.push(m); found = true; break; }
      }
      if (!found) groups.push({ bearing: brg, tracks: [m] });
    }

    for (const g of groups) {
      const count = g.tracks.length;
      const countStr = count === 1 ? 'one' : count === 2 ? 'two' : String(count);
      emit(world, { station: 'TAO-Air', priority: 'flash', text: `TAO-Air: VAMPIRE VAMPIRE, bearing ${fmtBrg(g.bearing)}, ${countStr} missiles inbound.` });
      for (const m of g.tracks) st.reportedMissiles.add(m.id);
    }
  }

  for (let i = st.pendingHostile.length - 1; i >= 0; i--) {
    const assoc = st.pendingHostile[i];
    if (!st.reportedMissiles.has(assoc.missileId)) continue;
    const launcher = world.contactById(assoc.launcherId);
    if (!launcher || !launcher.alive) { st.pendingHostile.splice(i, 1); continue; }
    const launcherTrack = world.trackFor(assoc.launcherId);
    if (!launcherTrack || !launcherTrack.detected) continue;
    if (launcher.classification !== 'hostile') {
      executeCommand(world, { action: 'classify', target: assoc.launcherId, classification: 'hostile' }, 'crew-auto');
    }
    st.pendingHostile.splice(i, 1);
  }
}

export function stepCrew(world: World): void {
  const st = getState(world);
  const tracks = world.visibleTracks();
  const t = world.time;

  processEvents(world, st);

  for (const track of tracks) {
    if (track.ownMissile) continue;
    if (track.domain === 'missile') continue;
    processTrack(world, st, track, t);
  }

  processMissileFlash(world, st, tracks, t);

  for (const track of tracks) {
    st.prev.set(track.id, snap(track));
  }
}
