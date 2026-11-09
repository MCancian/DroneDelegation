import { describe, it, expect } from 'vitest';
import { World } from '../src/sim/world';
import { STEP_S } from '../src/sim/clock';
import { rangeTo } from '../src/sim/geo';
import { WEAPONS_CONFIG, type WeaponsConfig } from '../src/sim/scenario/weaponsConfig';
import type { MissileLaunchRequest } from '../src/sim/scenario/scenario';
import type { OwnShip, RadarContact } from '../src/sim/types';
import {
  fireSam,
  fireGun,
  fireCiws,
  deployChaff,
  setPointDefense,
  launchAscms,
  chaffActive,
  interceptPoint,
} from '../src/sim/weapons';

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
  for (let i = 0; i < Math.round(seconds / STEP_S); i++) {
    world.step(STEP_S);
  }
}

function stepUntil(world: World, pred: () => boolean, maxS: number): boolean {
  const maxSteps = Math.round(maxS / STEP_S);
  for (let i = 0; i < maxSteps; i++) {
    if (pred()) return true;
    world.step(STEP_S);
  }
  return pred();
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
// Tests
// ---------------------------------------------------------------------------

describe('validation', () => {
  it('SAM out of range', () => {
    const world = makeWorld([
      makeContact({ id: 'near', position: { x: 0, y: 2 } }),
      makeContact({ id: 'far', position: { x: 0, y: 45 } }),
      makeContact({ id: 'max', position: { x: 0, y: 40 } }),
      makeContact({ id: 'min', position: { x: 0, y: 3 } }),
    ]);

    const r1 = fireSam(world, 'near', 'player');
    expect(r1).toEqual({ ok: false, error: 'out_of_range', message: expect.any(String) });
    expect(world.ownShip.inventory.sam).toBe(24);

    const r2 = fireSam(world, 'far', 'player');
    expect(r2).toEqual({ ok: false, error: 'out_of_range', message: expect.any(String) });
    expect(world.ownShip.inventory.sam).toBe(24);

    const r3 = fireSam(world, 'max', 'player');
    expect(r3.ok).toBe(true);
    expect(world.ownShip.inventory.sam).toBe(22);

    const r4 = fireSam(world, 'min', 'player');
    expect(r4.ok).toBe(true);
    expect(world.ownShip.inventory.sam).toBe(20);
  });

  it('gun out of range', () => {
    const worldOk = makeWorld([
      makeContact({ id: 's1', trackId: 'S-01', domain: 'surface', size: 'small', position: { x: 0, y: 8.9 } }),
    ]);
    const r1 = fireGun(worldOk, 's1', 'player');
    expect(r1.ok).toBe(true);

    const worldFar = makeWorld([
      makeContact({ id: 's2', trackId: 'S-02', domain: 'surface', size: 'ship', position: { x: 0, y: 9.5 } }),
    ]);
    const r2 = fireGun(worldFar, 's2', 'player');
    expect(r2).toEqual({ ok: false, error: 'out_of_range', message: expect.any(String) });
  });

  it('CIWS range and target validation', () => {
    const world = makeWorld([]);
    setPointDefense(world, 'manual', 'player');
    launchAscms(world, ascmReq({ x: 0, y: 2.5 }));

    stepFor(world, 4);

    const r1 = fireCiws(world, 'ascm-1', 'player');
    expect(r1).toEqual({ ok: false, error: 'out_of_range', message: expect.any(String) });

    const reached = stepUntil(world, () => {
      const c = world.contactById('ascm-1');
      return c !== undefined && c.alive && rangeTo(world.ownShip.position, c.position) <= 1.4;
    }, 10);
    expect(reached).toBe(true);

    const r2 = fireCiws(world, 'ascm-1', 'player');
    expect(r2.ok).toBe(true);
    expect(world.ownShip.inventory.ciws).toBe(900);

    const world2 = makeWorld([makeContact({ id: 'air1', domain: 'air', position: { x: 0, y: 1 } })]);
    const r3 = fireCiws(world2, 'air1', 'player');
    expect(r3).toEqual({ ok: false, error: 'invalid_target', message: expect.any(String) });
  });

  it('invalid_target cases', () => {
    const world = makeWorld([
      makeContact({ id: 'surf', domain: 'surface', size: 'ship', position: { x: 0, y: 5 } }),
      makeContact({ id: 'dead', position: { x: 0, y: 10 } }),
      makeContact({ id: 'far95', position: { x: 0, y: 95 } }),
    ]);

    const r1 = fireSam(world, 'nope', 'player');
    expect(r1).toEqual({ ok: false, error: 'invalid_target', message: expect.any(String) });

    const r2 = fireSam(world, 'surf', 'player');
    expect(r2).toEqual({ ok: false, error: 'invalid_target', message: expect.any(String) });

    const worldGun = makeWorld([makeContact({ id: 'air', domain: 'air', position: { x: 0, y: 5 } })]);
    const r3 = fireGun(worldGun, 'air', 'player');
    expect(r3).toEqual({ ok: false, error: 'invalid_target', message: expect.any(String) });

    const deadContact = world.contactById('dead');
    expect(deadContact).toBeDefined();
    deadContact!.alive = false;
    const r4 = fireSam(world, 'dead', 'player');
    expect(r4).toEqual({ ok: false, error: 'invalid_target', message: expect.any(String) });

    const r5 = fireSam(world, 'far95', 'player');
    expect(r5).toEqual({ ok: false, error: 'invalid_target', message: expect.any(String) });

    const worldInterceptor = makeWorld([makeContact({ id: 't20', position: { x: 0, y: 20 } })]);
    fireSam(worldInterceptor, 't20', 'player');
    const r6 = fireSam(worldInterceptor, 'sam-1', 'player');
    expect(r6).toEqual({ ok: false, error: 'invalid_target', message: expect.any(String) });
  });

  it('no_inventory', () => {
    const worldSam = makeWorld(
      [makeContact({ position: { x: 0, y: 10 } })],
      { ownShip: { inventory: { sam: 1, chaff: 6, gunBursts: 40, ciws: 1000 } } },
    );
    const r1 = fireSam(worldSam, 'tgt', 'player');
    expect(r1).toEqual({ ok: false, error: 'no_inventory', message: expect.any(String) });

    const worldChaff = makeWorld([], {
      ownShip: { inventory: { sam: 24, chaff: 0, gunBursts: 40, ciws: 1000 } },
    });
    const r2 = deployChaff(worldChaff, 'player');
    expect(r2).toEqual({ ok: false, error: 'no_inventory', message: expect.any(String) });

    const worldGun = makeWorld(
      [makeContact({ id: 's', domain: 'surface', size: 'small', position: { x: 0, y: 5 } })],
      { ownShip: { inventory: { sam: 24, chaff: 6, gunBursts: 0, ciws: 1000 } } },
    );
    const r3 = fireGun(worldGun, 's', 'player');
    expect(r3).toEqual({ ok: false, error: 'no_inventory', message: expect.any(String) });
  });

  it('gun busy', () => {
    const world = makeWorld(
      [makeContact({ id: 's', domain: 'surface', size: 'small', position: { x: 0, y: 5 } })],
      { weaponsConfig: { ...WEAPONS_CONFIG, gun: { ...WEAPONS_CONFIG.gun, pkPerBurst: 0 } } },
    );

    const r1 = fireGun(world, 's', 'player');
    expect(r1.ok).toBe(true);

    const r2 = fireGun(world, 's', 'player');
    expect(r2).toEqual({ ok: false, error: 'busy', message: expect.any(String) });

    stepFor(world, 10.1);

    const target = world.contactById('s');
    expect(target).toBeDefined();
    expect(target!.alive).toBe(true);

    const r3 = fireGun(world, 's', 'player');
    expect(r3.ok).toBe(true);
    expect(world.ownShip.inventory.gunBursts).toBe(38);
  });
});

describe('inventory decrement', () => {
  it('fireSam creates interceptors and decrements inventory', () => {
    const world = makeWorld([makeContact({ position: { x: 0, y: 20 } })]);

    const result = fireSam(world, 'tgt', 'player');
    expect(result.ok).toBe(true);
    expect(world.ownShip.inventory.sam).toBe(22);

    const sam1 = world.contactById('sam-1');
    const sam2 = world.contactById('sam-2');
    expect(sam1).toBeDefined();
    expect(sam2).toBeDefined();
    expect(sam1!.domain).toBe('missile');
    expect(sam2!.domain).toBe('missile');
    expect(sam1!.truth).toBe('friendly');
    expect(sam2!.truth).toBe('friendly');
    expect(sam1!.classification).toBe('friendly');
    expect(sam2!.classification).toBe('friendly');
    expect(sam1!.ownMissile).toBe(true);
    expect(sam2!.ownMissile).toBe(true);
    expect(sam1!.trackId).toBe('M-01');
    expect(sam2!.trackId).toBe('M-02');

    const fired = events(world, 'weapon_fired');
    expect(fired.length).toBe(1);
    expect(fired[0].actor).toBe('player');
    expect((fired[0].payload as Record<string, unknown>).weapon).toBe('sam');

    stepFor(world, 4);
    const visible = world.visibleTracks();
    const m01 = visible.find((t) => t.trackId === 'M-01');
    expect(m01).toBeDefined();
    expect(m01!.classification).toBe('friendly');
  });

  it('fireGun and deployChaff decrement inventory', () => {
    const world = makeWorld([
      makeContact({ id: 's', domain: 'surface', size: 'small', position: { x: 0, y: 5 } }),
    ]);

    fireGun(world, 's', 'player');
    expect(world.ownShip.inventory.gunBursts).toBe(39);

    deployChaff(world, 'player');
    expect(world.ownShip.inventory.chaff).toBe(5);
    expect(chaffActive(world)).toBe(true);

    stepFor(world, 60.1);
    expect(chaffActive(world)).toBe(false);
  });
});

describe('SAM flight time proportional to range', () => {
  it('flight times at 10, 20, 40 nm', () => {
    const results: number[] = [];
    const arrivalTimes: number[] = [];

    for (const rangeNm of [10, 20, 40]) {
      const world = makeWorld([makeContact({ position: { x: 0, y: rangeNm } })]);
      fireSam(world, 'tgt', 'player');

      const fired = events(world, 'weapon_fired');
      const flightTimeS = (fired[0].payload as Record<string, unknown>).flightTimeS as number;
      results.push(flightTimeS);

      stepUntil(world, () => events(world, 'weapon_result').length > 0, 100);
      const resultEvents = events(world, 'weapon_result');
      expect(resultEvents.length).toBeGreaterThan(0);
      arrivalTimes.push(resultEvents[0].t);
    }

    expect(results[0]).toBeCloseTo(20, 6);
    expect(results[1]).toBeCloseTo(40, 6);
    expect(results[2]).toBeCloseTo(80, 6);

    expect(Math.abs(arrivalTimes[0] - 20)).toBeLessThan(0.11);
    expect(Math.abs(arrivalTimes[1] - 40)).toBeLessThan(0.11);
    expect(Math.abs(arrivalTimes[2] - 80)).toBeLessThan(0.11);

    expect(results[2] / results[0]).toBeCloseTo(4, 6);
  });

  it('interceptPoint calculations', () => {
    const r1 = interceptPoint({ x: 0, y: 0 }, 1800, { x: 0, y: 20 }, 180, 0);
    expect(r1.timeS).toBeCloseTo(40, 6);
    expect(r1.point.x).toBeCloseTo(0, 6);
    expect(r1.point.y).toBeCloseTo(20, 6);

    const r2 = interceptPoint({ x: 0, y: 0 }, 1800, { x: 0, y: 20 }, 180, 600);
    expect(r2.timeS).toBeCloseTo(30, 6);
    expect(r2.point.y).toBeCloseTo(15, 6);
  });
});
