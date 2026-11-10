import type { World } from './world';
import type {
  Actor,
  Classification,
  ContactResponses,
  IffInfo,
  PointDefenseMode,
  RadarContact,
} from './types';
import { bearingTo, rangeTo } from './geo';
import { setBehavior } from './kinematics';
import {
  fireSam,
  fireGun,
  fireCiws,
  deployChaff,
  setPointDefense,
} from './weapons';
import type { CommandResponsePayload } from './events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getResponses(contact: RadarContact): ContactResponses | undefined {
  return contact.responses;
}

// ---------------------------------------------------------------------------
// Command types
// ---------------------------------------------------------------------------

export type CommandActor = Exclude<Actor, 'scenario'>;

const VALID_ACTORS: readonly string[] = ['player', 'ai-chat', 'ai-auto', 'doctrine', 'crew-auto'];

export type Command =
  | { action: 'iff_challenge'; target: string }
  | { action: 'radio_warning'; target: string }
  | { action: 'hail'; target: string }
  | { action: 'illuminate'; target: string }
  | { action: 'warning_shots'; target: string }
  | { action: 'engage_sam'; target: string }
  | { action: 'engage_gun'; target: string }
  | { action: 'ciws'; target: string }
  | { action: 'chaff' }
  | { action: 'classify'; target: string; classification: Classification }
  | { action: 'maneuver'; courseDeg: number; speedKts: number }
  | { action: 'set_point_defense'; mode: PointDefenseMode };

export type CommandResult = { ok: true } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLASSIFICATION_ALLOWLIST: readonly Classification[] = [
  'unknown',
  'neutral',
  'friendly',
  'suspect',
  'hostile',
];

const MODE_ALLOWLIST: readonly PointDefenseMode[] = ['auto', 'manual'];

const RESPONSE_DELAY_S = 5;

const WARNING_SHOTS_MAX_RANGE_NM = 6;

const MANEUVER_MAX_SPEED_KTS = 35;

// ---------------------------------------------------------------------------
// Pending response queue (WeakMap per World)
// ---------------------------------------------------------------------------

interface PendingResponse {
  action: string;
  target: string;
  actor: CommandActor;
  dueAtS: number;
  /** Snapshot: can the contact hear radio at order-time? */
  radioHeard: boolean;
}

const pendingQueue = new WeakMap<World, PendingResponse[]>();

function getPending(world: World): PendingResponse[] {
  let q = pendingQueue.get(world);
  if (!q) {
    q = [];
    pendingQueue.set(world, q);
  }
  return q;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTargeted(cmd: Command): cmd is Command & { target: string } {
  return 'target' in cmd;
}

function isVisible(world: World, targetId: string): boolean {
  const track = world.trackFor(targetId);
  return track !== undefined && track.detected === true;
}

function isOwnMissile(contact: RadarContact): boolean {
  return contact.ownMissile === true;
}

function hasPendingDuplicate(world: World, target: string, action: string): boolean {
  return pendingQueue.get(world)?.some((p) => p.target === target && p.action === action) ?? false;
}

// ---------------------------------------------------------------------------
// validateCommand — pure, no mutation, no log, no RNG
// ---------------------------------------------------------------------------

export function validateCommand(world: World, cmd: Command): CommandResult {
  // Ship lost check
  if (world.weapons.shipLost) {
    return { ok: false, error: 'Ship is lost' };
  }

  // Unknown action guard (TypeScript narrows, but runtime safety)
  const action = cmd.action;

  switch (action) {
    case 'maneuver': {
      const { courseDeg, speedKts } = cmd;
      if (!Number.isFinite(courseDeg) || courseDeg < 0 || courseDeg >= 360) {
        return { ok: false, error: `Invalid course ${courseDeg}: must be finite and 0 <= course < 360` };
      }
      if (!Number.isFinite(speedKts) || speedKts < 0 || speedKts > MANEUVER_MAX_SPEED_KTS) {
        return { ok: false, error: `Invalid speed ${speedKts}: must be finite and 0..${MANEUVER_MAX_SPEED_KTS}` };
      }
      return { ok: true };
    }

    case 'set_point_defense': {
      if (!MODE_ALLOWLIST.includes(cmd.mode)) {
        return { ok: false, error: `Invalid mode '${cmd.mode}'` };
      }
      return { ok: true };
    }

    case 'chaff': {
      if (world.ownShip.inventory.chaff < 1) {
        return { ok: false, error: 'No chaff remaining' };
      }
      return { ok: true };
    }

    case 'classify': {
      if (!CLASSIFICATION_ALLOWLIST.includes(cmd.classification)) {
        return { ok: false, error: `Invalid classification '${cmd.classification}'` };
      }
      const contact = world.contactById(cmd.target);
      if (!contact || !contact.alive || !isVisible(world, cmd.target)) {
        return { ok: false, error: `Target ${cmd.target} is not a valid visible target` };
      }
      if (isOwnMissile(contact)) {
        return { ok: false, error: `Target ${cmd.target} is an own missile` };
      }
      return { ok: true };
    }

    case 'iff_challenge': {
      const contact = world.contactById(cmd.target);
      if (!contact || !contact.alive || !isVisible(world, cmd.target)) {
        return { ok: false, error: `Target ${cmd.target} is not a valid visible target` };
      }
      if (isOwnMissile(contact)) {
        return { ok: false, error: `Target ${cmd.target} is an own missile` };
      }
      if (contact.domain !== 'air') {
        return { ok: false, error: `Target ${cmd.target} domain '${contact.domain}' is not valid for IFF challenge` };
      }
      if (hasPendingDuplicate(world, cmd.target, 'iff_challenge')) {
        return { ok: false, error: `Pending IFF challenge already exists for ${cmd.target}` };
      }
      return { ok: true };
    }

    case 'radio_warning': {
      const contact = world.contactById(cmd.target);
      if (!contact || !contact.alive || !isVisible(world, cmd.target)) {
        return { ok: false, error: `Target ${cmd.target} is not a valid visible target` };
      }
      if (isOwnMissile(contact)) {
        return { ok: false, error: `Target ${cmd.target} is an own missile` };
      }
      if (contact.domain !== 'air' && contact.domain !== 'surface') {
        return { ok: false, error: `Target ${cmd.target} domain '${contact.domain}' is not valid for radio warning` };
      }
      if (hasPendingDuplicate(world, cmd.target, 'radio_warning')) {
        return { ok: false, error: `Pending radio warning already exists for ${cmd.target}` };
      }
      return { ok: true };
    }

    case 'hail': {
      const contact = world.contactById(cmd.target);
      if (!contact || !contact.alive || !isVisible(world, cmd.target)) {
        return { ok: false, error: `Target ${cmd.target} is not a valid visible target` };
      }
      if (isOwnMissile(contact)) {
        return { ok: false, error: `Target ${cmd.target} is an own missile` };
      }
      if (contact.domain !== 'surface') {
        return { ok: false, error: `Target ${cmd.target} domain '${contact.domain}' is not valid for hail` };
      }
      if (hasPendingDuplicate(world, cmd.target, 'hail')) {
        return { ok: false, error: `Pending hail already exists for ${cmd.target}` };
      }
      return { ok: true };
    }

    case 'illuminate': {
      const contact = world.contactById(cmd.target);
      if (!contact || !contact.alive || !isVisible(world, cmd.target)) {
        return { ok: false, error: `Target ${cmd.target} is not a valid visible target` };
      }
      if (isOwnMissile(contact)) {
        return { ok: false, error: `Target ${cmd.target} is an own missile` };
      }
      if (contact.domain !== 'air') {
        return { ok: false, error: `Target ${cmd.target} domain '${contact.domain}' is not valid for illuminate` };
      }
      if (hasPendingDuplicate(world, cmd.target, 'illuminate')) {
        return { ok: false, error: `Pending illuminate already exists for ${cmd.target}` };
      }
      return { ok: true };
    }

    case 'warning_shots': {
      const contact = world.contactById(cmd.target);
      if (!contact || !contact.alive || !isVisible(world, cmd.target)) {
        return { ok: false, error: `Target ${cmd.target} is not a valid visible target` };
      }
      if (isOwnMissile(contact)) {
        return { ok: false, error: `Target ${cmd.target} is an own missile` };
      }
      if (contact.domain !== 'surface') {
        return { ok: false, error: `Target ${cmd.target} domain '${contact.domain}' is not valid for warning shots` };
      }
      const range = rangeTo(world.ownShip.position, contact.position);
      if (range > WARNING_SHOTS_MAX_RANGE_NM) {
        return { ok: false, error: `Target at ${range.toFixed(1)} nm exceeds warning shots range ${WARNING_SHOTS_MAX_RANGE_NM} nm` };
      }
      if (world.ownShip.inventory.gunBursts < 1) {
        return { ok: false, error: 'No gun bursts remaining' };
      }
      if (world.weapons.gunBurst !== null) {
        return { ok: false, error: 'Gun is already engaged' };
      }
      if (hasPendingDuplicate(world, cmd.target, 'warning_shots')) {
        return { ok: false, error: `Pending warning shots already exists for ${cmd.target}` };
      }
      return { ok: true };
    }

    case 'engage_sam': {
      const contact = world.contactById(cmd.target);
      if (!contact || !contact.alive || !isVisible(world, cmd.target)) {
        return { ok: false, error: `Target ${cmd.target} is not a valid visible target` };
      }
      if (isOwnMissile(contact)) {
        return { ok: false, error: `Target ${cmd.target} is an own missile` };
      }
      if (contact.domain !== 'air' && contact.domain !== 'missile') {
        return { ok: false, error: `Target ${cmd.target} domain '${contact.domain}' is not valid for SAM` };
      }
      const cfg = world.weapons.config.sam;
      const range = rangeTo(world.ownShip.position, contact.position);
      if (range < cfg.minRangeNm || range > cfg.maxRangeNm) {
        return { ok: false, error: `Target at ${range.toFixed(1)} nm is outside SAM range [${cfg.minRangeNm}, ${cfg.maxRangeNm}] nm` };
      }
      if (world.ownShip.inventory.sam < cfg.salvoSize) {
        return { ok: false, error: `Insufficient SAM inventory: ${world.ownShip.inventory.sam} < ${cfg.salvoSize}` };
      }
      return { ok: true };
    }

    case 'engage_gun': {
      const contact = world.contactById(cmd.target);
      if (!contact || !contact.alive || !isVisible(world, cmd.target)) {
        return { ok: false, error: `Target ${cmd.target} is not a valid visible target` };
      }
      if (isOwnMissile(contact)) {
        return { ok: false, error: `Target ${cmd.target} is an own missile` };
      }
      if (contact.domain !== 'surface') {
        return { ok: false, error: `Target ${cmd.target} domain '${contact.domain}' is not valid for gun` };
      }
      const cfg = world.weapons.config.gun;
      const range = rangeTo(world.ownShip.position, contact.position);
      if (range > cfg.maxRangeNm) {
        return { ok: false, error: `Target at ${range.toFixed(1)} nm exceeds gun range ${cfg.maxRangeNm} nm` };
      }
      if (world.ownShip.inventory.gunBursts < 1) {
        return { ok: false, error: 'No gun bursts remaining' };
      }
      if (world.weapons.gunBurst !== null) {
        return { ok: false, error: 'Gun is already engaged' };
      }
      return { ok: true };
    }

    case 'ciws': {
      const contact = world.contactById(cmd.target);
      if (!contact || !contact.alive || !isVisible(world, cmd.target)) {
        return { ok: false, error: `Target ${cmd.target} is not a valid visible target` };
      }
      if (isOwnMissile(contact)) {
        return { ok: false, error: `Target ${cmd.target} is an own missile` };
      }
      if (contact.domain !== 'missile') {
        return { ok: false, error: `Target ${cmd.target} domain '${contact.domain}' is not valid for CIWS` };
      }
      if (!world.weapons.ascms[cmd.target]) {
        return { ok: false, error: `Target ${cmd.target} is not an inbound missile` };
      }
      const ascm = world.weapons.ascms[cmd.target];
      if (ascm.ciwsEngaged) {
        return { ok: false, error: `CIWS already engaged on ${cmd.target}` };
      }
      const cfg = world.weapons.config.ciws;
      const range = rangeTo(world.ownShip.position, contact.position);
      if (range > cfg.maxRangeNm) {
        return { ok: false, error: `Target at ${range.toFixed(1)} nm exceeds CIWS range ${cfg.maxRangeNm} nm` };
      }
      if (world.ownShip.inventory.ciws < cfg.roundsPerEngagement) {
        return { ok: false, error: `Insufficient CIWS rounds: ${world.ownShip.inventory.ciws} < ${cfg.roundsPerEngagement}` };
      }
      return { ok: true };
    }

    default: {
      return { ok: false, error: `Unknown action '${action}'` };
    }
  }
}

// ---------------------------------------------------------------------------
// executeCommand
// ---------------------------------------------------------------------------

export function executeCommand(world: World, cmd: Command, actor: CommandActor): CommandResult {
  // Runtime guard: reject any actor outside the five valid command actors
  if (!VALID_ACTORS.includes(actor)) {
    return { ok: false, error: `Invalid actor '${actor}'` };
  }

  const validation = validateCommand(world, cmd);

  // Log the command attempt (before effects/weapon logs)
  world.logEvent('command', actor, {
    command: structuredClone(cmd),
    ok: validation.ok,
    ...(validation.ok ? {} : { error: validation.error }),
    autonomy: { ...world.autonomy },
  });

  if (!validation.ok) {
    return validation;
  }

  // Execute effects
  const action = cmd.action;

  switch (action) {
    case 'maneuver': {
      world.ownShip.courseDeg = cmd.courseDeg;
      world.ownShip.speedKts = cmd.speedKts;
      return { ok: true };
    }

    case 'set_point_defense': {
      const previous = world.weapons.pointDefense;
      setPointDefense(world, cmd.mode, actor);
      if (previous !== cmd.mode) {
        world.logEvent('autonomy_changed', actor, {
          domain: 'pointDefense', previous, level: cmd.mode,
          autonomy: { ...world.autonomy, pointDefense: cmd.mode },
        });
      }
      return { ok: true };
    }

    case 'chaff': {
      const result = deployChaff(world, actor);
      if (!result.ok) {
        return { ok: false, error: result.message };
      }
      return { ok: true };
    }

    case 'classify': {
      const contact = world.contactById(cmd.target);
      if (contact) {
        contact.classification = cmd.classification;
      }
      return { ok: true };
    }

    case 'iff_challenge': {
      const contact = world.contactById(cmd.target);
      if (!contact) return { ok: false, error: 'Target vanished' };
      const radioHeard = true; // N/A for IFF
      getPending(world).push({
        action: 'iff_challenge',
        target: cmd.target,
        actor,
        dueAtS: world.time + RESPONSE_DELAY_S,
        radioHeard,
      });
      return { ok: true };
    }

    case 'radio_warning': {
      const contact = world.contactById(cmd.target);
      if (!contact) return { ok: false, error: 'Target vanished' };
      const responses = getResponses(contact);
      const radioRangeNm = responses?.radioRangeNm;
      const currentRange = rangeTo(world.ownShip.position, contact.position);
      const radioHeard = radioRangeNm === undefined || currentRange <= radioRangeNm;
      getPending(world).push({
        action: 'radio_warning',
        target: cmd.target,
        actor,
        dueAtS: world.time + RESPONSE_DELAY_S,
        radioHeard,
      });
      return { ok: true };
    }

    case 'hail': {
      const contact = world.contactById(cmd.target);
      if (!contact) return { ok: false, error: 'Target vanished' };
      getPending(world).push({
        action: 'hail',
        target: cmd.target,
        actor,
        dueAtS: world.time + RESPONSE_DELAY_S,
        radioHeard: true,
      });
      return { ok: true };
    }

    case 'illuminate': {
      const contact = world.contactById(cmd.target);
      if (!contact) return { ok: false, error: 'Target vanished' };
      getPending(world).push({
        action: 'illuminate',
        target: cmd.target,
        actor,
        dueAtS: world.time + RESPONSE_DELAY_S,
        radioHeard: true,
      });
      return { ok: true };
    }

    case 'warning_shots': {
      const contact = world.contactById(cmd.target);
      if (!contact) return { ok: false, error: 'Target vanished' };
      // Consume 1 gun burst, no kill roll
      world.ownShip.inventory.gunBursts -= 1;
      getPending(world).push({
        action: 'warning_shots',
        target: cmd.target,
        actor,
        dueAtS: world.time + RESPONSE_DELAY_S,
        radioHeard: true,
      });
      return { ok: true };
    }

    case 'engage_sam': {
      const result = fireSam(world, cmd.target, actor);
      if (!result.ok) {
        return { ok: false, error: result.message };
      }
      return { ok: true };
    }

    case 'engage_gun': {
      const result = fireGun(world, cmd.target, actor);
      if (!result.ok) {
        return { ok: false, error: result.message };
      }
      return { ok: true };
    }

    case 'ciws': {
      const result = fireCiws(world, cmd.target, actor);
      if (!result.ok) {
        return { ok: false, error: result.message };
      }
      return { ok: true };
    }

    default: {
      return { ok: false, error: `Unknown action '${action}'` };
    }
  }
}

// ---------------------------------------------------------------------------
// stepCommands — process delayed responses (called after sensor sweeps)
// ---------------------------------------------------------------------------

export function stepCommands(world: World): void {
  const queue = pendingQueue.get(world);
  if (!queue || queue.length === 0) return;

  const due: PendingResponse[] = [];
  const remaining: PendingResponse[] = [];

  for (const entry of queue) {
    if (world.time >= entry.dueAtS - 1e-9) {
      due.push(entry);
    } else {
      remaining.push(entry);
    }
  }

  // Replace queue with remaining
  pendingQueue.set(world, remaining);

  for (const entry of due) {
    const contact = world.contactById(entry.target);

    // Discard if dead or no longer visible
    if (!contact || !contact.alive || !isVisible(world, entry.target)) {
      continue;
    }

    const responses = getResponses(contact);
    const trackId = world.trackFor(entry.target)?.trackId ?? '';
    let payload: CommandResponsePayload;

    switch (entry.action) {
      case 'iff_challenge': {
        const iff = responses?.iff ?? contact.sensors.iff;
        if (iff) {
          contact.sensors.iff = structuredClone(iff);
        }
        payload = {
          action: 'iff_challenge',
          target: entry.target,
          trackId,
          outcome: 'iff',
          iff: iff ? structuredClone(iff) : undefined,
        };
        break;
      }

      case 'radio_warning': {
        const radioFlag = responses?.radio ?? 'ignore';
        if (entry.radioHeard && radioFlag === 'comply') {
          payload = {
            action: 'radio_warning',
            target: entry.target,
            trackId,
            outcome: 'complied',
          };
        } else {
          payload = {
            action: 'radio_warning',
            target: entry.target,
            trackId,
            outcome: 'ignored',
          };
        }
        break;
      }

      case 'hail': {
        const hailFlag = responses?.hail ?? 'ignore';
        const hasAis = contact.sensors.ais.kind === 'vessel';
        if (hailFlag === 'answer' && hasAis) {
          payload = {
            action: 'hail',
            target: entry.target,
            trackId,
            outcome: 'answered',
          };
        } else {
          payload = {
            action: 'hail',
            target: entry.target,
            trackId,
            outcome: 'ignored',
          };
        }
        break;
      }

      case 'illuminate': {
        const illumFlag = responses?.illuminate ?? 'ignore';
        if (illumFlag === 'turn-away') {
          const course = bearingTo(world.ownShip.position, contact.position);
          setBehavior(contact, {
            kind: 'turnAway',
            courseDeg: course,
            speedKts: contact.speedKts,
          });
          payload = {
            action: 'illuminate',
            target: entry.target,
            trackId,
            outcome: 'complied',
          };
        } else {
          payload = {
            action: 'illuminate',
            target: entry.target,
            trackId,
            outcome: 'ignored',
          };
        }
        break;
      }

      case 'warning_shots': {
        const wsFlag = responses?.warningShots ?? 'ignore';
        if (wsFlag === 'turn-away') {
          const course = bearingTo(world.ownShip.position, contact.position);
          const newSpeed = Math.min(5, contact.speedKts);
          setBehavior(contact, {
            kind: 'turnAway',
            courseDeg: course,
            speedKts: newSpeed,
          });
          payload = {
            action: 'warning_shots',
            target: entry.target,
            trackId,
            outcome: 'complied',
          };
        } else {
          payload = {
            action: 'warning_shots',
            target: entry.target,
            trackId,
            outcome: 'ignored',
          };
        }
        break;
      }

      default: {
        continue;
      }
    }

    world.logEvent('command_response', entry.actor, payload);
  }
}
