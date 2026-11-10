import { World } from '../../src/sim/world';
import { STEP_S } from '../../src/sim/clock';
import { stepCrew } from '../../src/sim/scenario/crew';
import type { ScenarioRunner } from '../../src/sim/scenario/scenario';
import { WEAPONS_CONFIG, type WeaponsConfig } from '../../src/sim/scenario/weaponsConfig';
import type { OwnShip, RadarContact } from '../../src/sim/types';

/** Retrieve the world-owned contact reference by id; throws if not found. */
export function worldContact(world: World, id: string): RadarContact {
  const contact = world.contactById(id);
  if (!contact) {
    throw new Error(`worldContact: contact '${id}' not found in world`);
  }
  return contact;
}

/** Deep-clone a weapons config for isolation between worlds. */
export function cloneWeaponsConfig(base: WeaponsConfig = WEAPONS_CONFIG): WeaponsConfig {
  return structuredClone(base);
}

/** Return a weapons config with all Pk fields set to exactly 0 or 1. */
export function deterministicWeaponsConfig(pk: 0 | 1): WeaponsConfig {
  if (pk !== 0 && pk !== 1) {
    throw new Error(`deterministicWeaponsConfig: pk must be exactly 0 or 1, got ${String(pk)}`);
  }
  const cfg = structuredClone(WEAPONS_CONFIG);
  cfg.sam.pkSalvoVsAircraft = pk;
  cfg.sam.pkPerMissileVsAscm = pk;
  cfg.gun.pkPerBurst = pk;
  cfg.ciws.pkPerMissile = pk;
  cfg.ascm.pHit = pk;
  cfg.ascm.pHitChaff = pk;
  return cfg;
}

/** Build an OwnShip with sensible defaults; overrides are shallow-merged then deep-cloned. */
export function makeOwnShip(overrides: Partial<OwnShip> = {}): OwnShip {
  const base: OwnShip = {
    position: { x: 0, y: 0 },
    courseDeg: 0,
    speedKts: 0,
    hullPct: 100,
    inventory: { sam: 24, chaff: 6, gunBursts: 40, ciws: 1000 },
  };
  const merged = { ...base, ...overrides };
  return structuredClone(merged);
}

/** Build a RadarContact with sensible defaults; overrides are shallow-merged then deep-cloned. */
export function makeContact(overrides: Partial<RadarContact> = {}): RadarContact {
  const base: RadarContact = {
    id: 'tgt',
    trackId: 'A-01',
    domain: 'air',
    truth: 'hostile',
    position: { x: 0, y: 10 },
    courseDeg: 180,
    speedKts: 0,
    altitudeFt: 15000,
    classification: 'unknown',
    sensors: {
      iff: { kind: 'none' },
      ais: { kind: 'none' },
      esm: { kind: 'none' },
      visual: { kind: 'none' },
    },
    alive: true,
    history: [],
  };
  const merged = { ...base, ...overrides };
  return structuredClone(merged);
}

/** Create a World with independent weapons config; contacts are cloned by World constructor. */
export function makeWorld(
  contacts: RadarContact[] = [],
  opts?: { seed?: number; weaponsConfig?: WeaponsConfig; ownShip?: Partial<OwnShip> },
): World {
  const seed = opts?.seed ?? 1;
  const ownShip = makeOwnShip(opts?.ownShip);
  const weaponsConfig = opts?.weaponsConfig
    ? structuredClone(opts.weaponsConfig)
    : cloneWeaponsConfig();
  return new World({ seed, ownShip, contacts, weaponsConfig });
}

function validateSeconds(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`seconds must be finite and nonnegative, got ${String(seconds)}`);
  }
  const steps = seconds / STEP_S;
  const rounded = Math.round(steps);
  if (Math.abs(steps - rounded) > 1e-6) {
    throw new Error(
      `seconds must be a whole multiple of STEP_S (${STEP_S}), got ${String(seconds)} (steps=${String(steps)})`,
    );
  }
}

/** Step the world only (no crew, no scenario). Returns number of steps executed. */
export function stepWorld(world: World, seconds: number): number {
  validateSeconds(seconds);
  const steps = Math.round(seconds / STEP_S);
  for (let i = 0; i < steps; i++) {
    world.step(STEP_S);
  }
  return steps;
}

/** Step the world then call stepCrew once per step. Returns number of steps executed. */
export function stepWorldWithCrew(world: World, seconds: number): number {
  validateSeconds(seconds);
  const steps = Math.round(seconds / STEP_S);
  for (let i = 0; i < steps; i++) {
    world.step(STEP_S);
    stepCrew(world);
  }
  return steps;
}

/** Step via ScenarioRunner (world.step + runner.update which calls stepCrew). Caps at remaining scenario duration. */
export function stepScenario(runner: ScenarioRunner, seconds: number): number {
  validateSeconds(seconds);
  const steps = Math.round(seconds / STEP_S);
  const remaining = Math.max(
    0,
    Math.round((runner.scenario.durationS - runner.world.time) / STEP_S),
  );
  const effectiveSteps = Math.min(steps, remaining);
  let executed = 0;
  for (let i = 0; i < effectiveSteps; i++) {
    if (runner.world.weapons.shipLost) break;
    runner.world.step(STEP_S);
    runner.update();
    executed++;
    if (runner.world.weapons.shipLost) break;
  }
  return executed;
}
