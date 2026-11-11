import { describe, it, expect } from 'vitest';
import { World } from '../src/sim/world';
import { STEP_S } from '../src/sim/clock';
import { rangeTo } from '../src/sim/geo';
import {
  fireSam,
  fireGun,
  deployChaff,
  setPointDefense,
  launchAscms,
} from '../src/sim/weapons';
import { WEAPONS_CONFIG, type WeaponsConfig } from '../src/sim/scenario/weaponsConfig';
import type { MissileLaunchRequest } from '../src/sim/scenario/scenario';
import type { OwnShip, RadarContact } from '../src/sim/types';
import { STRAIT_TRANSIT } from '../src/sim/scenario/strait';
import { runScenario } from '../src/sim/scenario/scenario';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOwnShip(): OwnShip {
  return {
    position: { x: 0, y: 0 },
    courseDeg: 0,
    speedKts: 0,
    hullPct: 100,
    inventory: { sam: 24, chaff: 6, gunBursts: 40, ciws: 1000 },
  };
}

function makeContact(overrides: Partial<RadarContact> = {}): RadarContact {
  return {
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
    ...overrides,
  };
}

function makeWorld(
  contacts: RadarContact[],
  opts?: { seed?: number; weaponsConfig?: WeaponsConfig; ownShip?: Partial<OwnShip> },
): World {
  return new World({
    seed: opts?.seed ?? 1,
    ownShip: { ...makeOwnShip(), ...opts?.ownShip },
    contacts,
    weaponsConfig: opts?.weaponsConfig,
  });
}

function stepFor(world: World, seconds: number): void {
  const steps = Math.round(seconds / STEP_S);
  for (let i = 0; i < steps; i++) world.step(STEP_S);
}

function stepUntil(world: World, pred: () => boolean, maxS: number): boolean {
  const maxSteps = Math.round(maxS / STEP_S);
  for (let i = 0; i < maxSteps; i++) {
    world.step(STEP_S);
    if (pred()) return true;
  }
  return false;
}

function ascmReq(position: { x: number; y: number }, overrides?: Partial<MissileLaunchRequest>): MissileLaunchRequest {
  return {
    count: 1,
    weapon: 'ASCM',
    speedKts: 600,
    altitudeFt: 50,
    launcherId: 'red',
    trackId: 'A-01',
    t: 0,
    position,
    rangeNm: Math.hypot(position.x, position.y),
    bearingDeg: 0,
    ...overrides,
  };
}

function events(world: World, type: string): { t: number; type: string; actor: string; payload: unknown }[] {
  return world.events.filter((e) => e.type === type);
}

// ---------------------------------------------------------------------------
// Pk statistics
// ---------------------------------------------------------------------------

describe('Pk statistics', () => {
  it('SAM vs aircraft kill rate ≈ 0.85', () => {
    const N = 1000;
    let kills = 0;
    for (let seed = 1; seed <= N; seed++) {
      const world = makeWorld([makeContact({ position: { x: 0, y: 10 } })], { seed });
      const result = fireSam(world, 'tgt', 'player');
      expect(result.ok).toBe(true);
      stepFor(world, 20.5);
      if (events(world, 'contact_destroyed').length > 0) kills++;
    }
    const rate = kills / N;
    expect(Math.abs(rate - 0.85)).toBeLessThan(0.04);
  });

  it('SAM vs ASCM kill rate ≈ 0.84', () => {
    const N = 1000;
    let kills = 0;
    for (let seed = 1; seed <= N; seed++) {
      const world = makeWorld([], { seed });
      setPointDefense(world, 'manual', 'player');
      launchAscms(world, ascmReq({ x: 0, y: 20 }));
      stepFor(world, 4);
      const result = fireSam(world, 'ascm-1', 'player');
      expect(result.ok).toBe(true);
      stepUntil(
        world,
        () => world.events.some((e) => e.type === 'weapon_result' && (e.payload as { weapon: string }).weapon === 'sam'),
        40,
      );
      const samResults = world.events.filter(
        (e) => e.type === 'weapon_result' && (e.payload as { weapon: string }).weapon === 'sam',
      );
      if (samResults.some((e) => (e.payload as { killed: boolean }).killed)) kills++;
    }
    const rate = kills / N;
    expect(Math.abs(rate - 0.84)).toBeLessThan(0.04);
  });

  it('CIWS auto kill rate ≈ 0.6', () => {
    const N = 1000;
    let kills = 0;
    for (let seed = 1; seed <= N; seed++) {
      const world = makeWorld([], { seed });
      setPointDefense(world, 'auto', 'player');
      launchAscms(world, ascmReq({ x: 0, y: 3 }));
      stepUntil(world, () => !world.contactById('ascm-1')?.alive, 30);
      const ciwsResults = world.events.filter(
        (e) => e.type === 'weapon_result' && (e.payload as { weapon: string }).weapon === 'ciws',
      );
      expect(ciwsResults.length).toBe(1);
      expect(ciwsResults[0].actor).toBe('crew-auto');
      if ((ciwsResults[0].payload as { killed: boolean }).killed) kills++;
    }
    const rate = kills / N;
    expect(Math.abs(rate - 0.6)).toBeLessThan(0.04);
  });

  it('ASCM hit rate without chaff ≈ 0.8, with chaff ≈ 0.45', () => {
    const N = 2000;

    let hitsNoChaff = 0;
    for (let seed = 1; seed <= N; seed++) {
      const world = makeWorld([], { seed });
      setPointDefense(world, 'manual', 'player');
      launchAscms(world, ascmReq({ x: 0, y: 1 }));
      stepUntil(world, () => events(world, 'missile_impact').length > 0, 10);
      const impacts = events(world, 'missile_impact');
      expect(impacts.length).toBe(1);
      expect((impacts[0].payload as { chaffActive: boolean }).chaffActive).toBe(false);
      if ((impacts[0].payload as { hit: boolean }).hit) hitsNoChaff++;
    }

    let hitsWithChaff = 0;
    for (let seed = 1; seed <= N; seed++) {
      const world = makeWorld([], { seed });
      setPointDefense(world, 'manual', 'player');
      deployChaff(world, 'player');
      launchAscms(world, ascmReq({ x: 0, y: 1 }));
      stepUntil(world, () => events(world, 'missile_impact').length > 0, 10);
      const impacts = events(world, 'missile_impact');
      expect(impacts.length).toBe(1);
      expect((impacts[0].payload as { chaffActive: boolean }).chaffActive).toBe(true);
      if ((impacts[0].payload as { hit: boolean }).hit) hitsWithChaff++;
    }

    const rateNoChaff = hitsNoChaff / N;
    const rateWithChaff = hitsWithChaff / N;

    expect(Math.abs(rateNoChaff - 0.8)).toBeLessThan(0.04);
    expect(Math.abs(rateWithChaff - 0.45)).toBeLessThan(0.04);
    expect(rateWithChaff).toBeLessThan(rateNoChaff);
  });
});

// ---------------------------------------------------------------------------
// Damage model
// ---------------------------------------------------------------------------

describe('Damage model', () => {
  it('Two hits → 80% damage', () => {
    const config: WeaponsConfig = {
      ...WEAPONS_CONFIG,
      ascm: { ...WEAPONS_CONFIG.ascm, pHit: 1 },
    };
    const world = makeWorld([], { seed: 1, weaponsConfig: config });
    setPointDefense(world, 'manual', 'player');
    launchAscms(world, ascmReq({ x: 0, y: 1 }, { count: 2 }));
    stepUntil(world, () => {
      const ascm1 = world.contactById('ascm-1');
      const ascm2 = world.contactById('ascm-2');
      return (!ascm1 || !ascm1.alive) && (!ascm2 || !ascm2.alive);
    }, 20);
    expect(world.ownShip.hullPct).toBe(20);
    const impacts = events(world, 'missile_impact');
    expect(impacts.length).toBe(2);
    expect(impacts.every((e) => (e.payload as { hit: boolean }).hit)).toBe(true);
    expect(events(world, 'ship_lost').length).toBe(0);
  });

  it('ship_lost at hull ≤ 0', () => {
    const config: WeaponsConfig = {
      ...WEAPONS_CONFIG,
      ascm: { ...WEAPONS_CONFIG.ascm, pHit: 1 },
    };
    const world = makeWorld([], { seed: 1, weaponsConfig: config });
    setPointDefense(world, 'manual', 'player');
    launchAscms(world, ascmReq({ x: 0, y: 1 }, { count: 3 }));
    stepUntil(world, () => events(world, 'ship_lost').length > 0, 20);
    expect(world.ownShip.hullPct).toBe(0);
    const shipLostEvents = events(world, 'ship_lost');
    expect(shipLostEvents.length).toBe(1);
    expect(shipLostEvents[0].actor).toBe('scenario');

    const samResult = fireSam(world, 'ascm-1', 'player');
    expect(samResult).toEqual({ ok: false, error: 'ship_lost', message: 'Ship is lost' });
    const chaffResult = deployChaff(world, 'player');
    expect(chaffResult).toEqual({ ok: false, error: 'ship_lost', message: 'Ship is lost' });
  });

  it('Casualties recorded on contact_destroyed', () => {
    const config: WeaponsConfig = {
      ...WEAPONS_CONFIG,
      sam: { ...WEAPONS_CONFIG.sam, pkSalvoVsAircraft: 1 },
    };
    const world = makeWorld(
      [makeContact({ id: 'airliner', truth: 'civil', personsAboard: 212, position: { x: 0, y: 10 } })],
      { seed: 1, weaponsConfig: config },
    );
    const result = fireSam(world, 'airliner', 'player');
    expect(result.ok).toBe(true);
    stepFor(world, 20.5);

    const airliner = world.contactById('airliner');
    expect(airliner?.alive).toBe(false);

    const destroyed = events(world, 'contact_destroyed');
    expect(destroyed.length).toBe(1);
    expect(destroyed[0].actor).toBe('player');
    expect(destroyed[0].payload).toMatchObject({
      contactId: 'airliner',
      truth: 'civil',
      casualties: 212,
      weapon: 'sam',
    });

    expect(world.contactById('sam-1')?.alive).toBe(false);
    expect(world.contactById('sam-2')?.alive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Point defense AUTO
// ---------------------------------------------------------------------------

describe('Point defense AUTO', () => {
  it('Auto chaff deploys when missile is within chaff duration', () => {
    // ASCM at (0,5): time to impact ≈ 29.4s ≤ 60s chaff duration
    const world = makeWorld([], { seed: 1 });
    setPointDefense(world, 'auto', 'player');
    launchAscms(world, ascmReq({ x: 0, y: 5 }));
    stepFor(world, 4.1);
    const chaffEvents = events(world, 'chaff_deployed');
    expect(chaffEvents.length).toBe(1);
    expect(chaffEvents[0].actor).toBe('crew-auto');
    expect(world.ownShip.inventory.chaff).toBe(5);
  });

  it('Auto chaff does not deploy when missile is far away, deploys when close enough', () => {
    // ASCM at (0,20): time to impact ≈ 120s > 60s initially
    const world = makeWorld([], { seed: 1 });
    setPointDefense(world, 'auto', 'player');
    launchAscms(world, ascmReq({ x: 0, y: 20 }));
    stepFor(world, 50);
    expect(events(world, 'chaff_deployed').length).toBe(0);

    stepUntil(world, () => {
      const c = world.contactById('ascm-1');
      if (!c || !c.alive) return true;
      return rangeTo(world.ownShip.position, c.position) <= 10;
    }, 60);
    stepFor(world, 4.1);
    expect(events(world, 'chaff_deployed').length).toBe(1);
  });

  it('Manual point defense: no CIWS or chaff auto events', () => {
    const world = makeWorld([], { seed: 1 });
    setPointDefense(world, 'manual', 'player');
    launchAscms(world, ascmReq({ x: 0, y: 3 }));
    stepUntil(world, () => !world.contactById('ascm-1')?.alive, 30);
    const ciwsFired = world.events.filter(
      (e) => e.type === 'weapon_fired' && (e.payload as { weapon: string }).weapon === 'ciws',
    );
    expect(ciwsFired.length).toBe(0);
    expect(events(world, 'chaff_deployed').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Full scenario
// ---------------------------------------------------------------------------

describe('Full scenario', () => {
  it('Seed 1: exactly 4 ascm_launched events, launcherIds match, a9 alive', () => {
    const { world } = runScenario(STRAIT_TRANSIT, 1);
    const ascmEvents = events(world, 'ascm_launched');
    expect(ascmEvents.length).toBe(4);
    const launcherIds = ascmEvents
      .map((e) => (e.payload as { launcherId: string }).launcherId)
      .sort();
    expect(launcherIds).toEqual(['a1', 'a1', 's7', 's7']);
    const a9 = world.contactById('a9');
    expect(a9?.alive).toBe(true);
  }, 30_000);

  it('Determinism: defended (seed 42)', () => {
    const run1 = runScenario(STRAIT_TRANSIT, 42);
    const run2 = runScenario(STRAIT_TRANSIT, 42);
    expect(JSON.stringify(run1.world.events)).toBe(JSON.stringify(run2.world.events));
    expect(run1.world.ownShip.hullPct).toBe(run2.world.ownShip.hullPct);
  }, 30_000);

  it('Determinism: undefended (seed 42)', () => {
    let setOnce1 = false;
    const run1 = runScenario(STRAIT_TRANSIT, 42, {
      onStep: (w) => {
        if (!setOnce1) {
          setPointDefense(w, 'manual', 'player');
          setOnce1 = true;
        }
      },
    });

    let setOnce2 = false;
    const run2 = runScenario(STRAIT_TRANSIT, 42, {
      onStep: (w) => {
        if (!setOnce2) {
          setPointDefense(w, 'manual', 'player');
          setOnce2 = true;
        }
      },
    });

    expect(JSON.stringify(run1.world.events)).toBe(JSON.stringify(run2.world.events));
    expect(run1.world.ownShip.hullPct).toBe(run2.world.ownShip.hullPct);
  }, 30_000);
});
