import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/sim/rng';
import {
  createSensorState,
  sweep,
  visibleTracks,
  visualDescriptionFor,
  canVisuallyIdentify,
} from '../src/sim/sensors';
import { buildContact } from '../src/sim/scenario/scenario';
import type { Contact, OwnShip } from '../src/sim/types';
import type { ScenarioContact } from '../src/sim/scenario/scenario';

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'c-1',
    trackId: '',
    domain: 'air',
    truth: 'civil',
    position: { x: 0, y: 0 },
    courseDeg: 0,
    speedKts: 0,
    altitudeFt: 0,
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

function makeOwnShip(overrides: Partial<OwnShip> = {}): OwnShip {
  return {
    position: { x: 0, y: 0 },
    courseDeg: 0,
    speedKts: 0,
    hullPct: 100,
    inventory: { sam: 24, chaff: 6, gunBursts: 40, ciws: 1000 },
    ...overrides,
  };
}

describe('visual ID in sweep', () => {
  it('a. surface small craft at 2.5 nm gets visual ID at t=0', () => {
    const rng = mulberry32(1);
    const own = makeOwnShip();
    const state = createSensorState();
    const c = makeContact({
      id: 'd',
      domain: 'surface',
      size: 'small',
      position: { x: 0, y: 2.5 },
      visualDescription: 'Fishing dhow',
    });

    sweep(state, [c], own, 0, rng);

    expect(state.tracks['d'].visual).toEqual({ kind: 'identified', description: 'Fishing dhow' });
    expect(state.tracks['d'].visualIdAt).toBe(0);
  });

  it('b. surface small craft at 3.5 nm is detected but not visually identified', () => {
    const rng = mulberry32(1);
    const own = makeOwnShip();
    const state = createSensorState();
    const c = makeContact({
      id: 'd',
      domain: 'surface',
      size: 'small',
      position: { x: 0, y: 3.5 },
      visualDescription: 'Fishing dhow',
    });

    sweep(state, [c], own, 0, rng);

    expect(state.tracks['d']).toBeDefined();
    expect(state.tracks['d'].detected).toBe(true);
    expect(state.tracks['d'].visual).toEqual({ kind: 'none' });
    expect(state.tracks['d'].visualIdAt).toBeNull();
  });

  it('c. boundary: exactly 3 nm is identified', () => {
    const rng = mulberry32(1);
    const own = makeOwnShip();
    const state = createSensorState();
    const c = makeContact({
      id: 'd',
      domain: 'surface',
      size: 'small',
      position: { x: 3, y: 0 },
      visualDescription: 'Fishing dhow',
    });

    sweep(state, [c], own, 0, rng);

    expect(state.tracks['d'].visual).toEqual({ kind: 'identified', description: 'Fishing dhow' });
  });

  it('d. latching: identified at t=0, still identified after moving to 8 nm at t=4', () => {
    const rng = mulberry32(1);
    const own = makeOwnShip();
    const state = createSensorState();
    const c = makeContact({
      id: 'd',
      domain: 'surface',
      size: 'small',
      position: { x: 0, y: 2 },
      visualDescription: 'Fishing dhow',
    });

    sweep(state, [c], own, 0, rng);
    expect(state.tracks['d'].visual).toEqual({ kind: 'identified', description: 'Fishing dhow' });

    c.position = { x: 0, y: 8 };
    sweep(state, [c], own, 4, rng);

    expect(state.tracks['d'].visual).toEqual({ kind: 'identified', description: 'Fishing dhow' });
    expect(state.tracks['d'].visualIdAt).toBe(0);
  });

  it('e. becomes identified later: 5 nm at t=0 (none), 2.9 nm at t=4 (identified)', () => {
    const rng = mulberry32(1);
    const own = makeOwnShip();
    const state = createSensorState();
    const c = makeContact({
      id: 'd',
      domain: 'surface',
      size: 'small',
      position: { x: 0, y: 5 },
      visualDescription: 'Fishing dhow',
    });

    sweep(state, [c], own, 0, rng);
    expect(state.tracks['d'].visual).toEqual({ kind: 'none' });
    expect(state.tracks['d'].visualIdAt).toBeNull();

    c.position = { x: 0, y: 2.9 };
    sweep(state, [c], own, 4, rng);

    expect(state.tracks['d'].visual).toEqual({ kind: 'identified', description: 'Fishing dhow' });
    expect(state.tracks['d'].visualIdAt).toBe(4);
  });
});

describe('visualDescriptionFor', () => {
  it('f. fallback descriptions', () => {
    expect(visualDescriptionFor(makeContact({ domain: 'air' }))).toBe('Aircraft');
    expect(visualDescriptionFor(makeContact({ domain: 'surface', size: 'small' }))).toBe('Small craft');
    expect(visualDescriptionFor(makeContact({ domain: 'surface' }))).toBe('Vessel');
    expect(visualDescriptionFor(makeContact({ domain: 'missile' }))).toBe('Missile');
    expect(visualDescriptionFor(makeContact({ domain: 'air', visualDescription: '' }))).toBe('Aircraft');
  });
});

describe('missiles are never visually identified', () => {
  it('g. missile domain at 1 nm: track exists, visual none', () => {
    const rng = mulberry32(1);
    const own = makeOwnShip();
    const state = createSensorState();
    const c = makeContact({ id: 'm', domain: 'missile', position: { x: 0, y: 1 } });

    sweep(state, [c], own, 0, rng);

    expect(state.tracks['m']).toBeDefined();
    expect(state.tracks['m'].visual).toEqual({ kind: 'none' });
  });

  it('g. ownMissile at 1 nm: visual none', () => {
    const rng = mulberry32(1);
    const own = makeOwnShip();
    const state = createSensorState();
    const c = makeContact({ id: 'm2', domain: 'missile', ownMissile: true, position: { x: 0, y: 1 } });

    sweep(state, [c], own, 0, rng);

    expect(state.tracks['m2']).toBeDefined();
    expect(state.tracks['m2'].visual).toEqual({ kind: 'none' });
  });
});

describe('canVisuallyIdentify', () => {
  it('h. dead contact is false', () => {
    const own = makeOwnShip();
    expect(canVisuallyIdentify(makeContact({ alive: false, position: { x: 0, y: 1 } }), own)).toBe(false);
  });

  it('h. alive air contact at 1 nm is true', () => {
    const own = makeOwnShip();
    expect(canVisuallyIdentify(makeContact({ domain: 'air', position: { x: 0, y: 1 } }), own)).toBe(true);
  });

  it('h. alive air contact at 3.01 nm is false', () => {
    const own = makeOwnShip();
    expect(canVisuallyIdentify(makeContact({ domain: 'air', position: { x: 0, y: 3.01 } }), own)).toBe(false);
  });
});

describe('visibleTracks strips ground truth and exposes visual info', () => {
  it('i. after visual ID: sensors.visual is set, visualDescription is absent, input not mutated', () => {
    const rng = mulberry32(1);
    const own = makeOwnShip();
    const state = createSensorState();
    const c = makeContact({
      id: 'd',
      domain: 'surface',
      size: 'small',
      position: { x: 0, y: 2.5 },
      visualDescription: 'Fishing dhow',
    });

    sweep(state, [c], own, 0, rng);

    const result = visibleTracks(state, [c], 0);
    expect(result.length).toBe(1);
    expect(result[0].sensors.visual).toEqual({ kind: 'identified', description: 'Fishing dhow' });
    expect('visualDescription' in result[0]).toBe(false);
    // Input not mutated
    expect(c.sensors.visual).toEqual({ kind: 'none' });
    expect(c.visualDescription).toBe('Fishing dhow');
  });

  it('j. before visual ID: sensors.visual is none, visualDescription is absent', () => {
    const rng = mulberry32(1);
    const own = makeOwnShip();
    const state = createSensorState();
    const c = makeContact({
      id: 'd',
      domain: 'surface',
      size: 'small',
      position: { x: 0, y: 3.5 },
      visualDescription: 'Fishing dhow',
    });

    sweep(state, [c], own, 0, rng);

    const result = visibleTracks(state, [c], 0);
    expect(result.length).toBe(1);
    expect(result[0].sensors.visual).toEqual({ kind: 'none' });
    expect('visualDescription' in result[0]).toBe(false);
  });
});

describe('buildContact sets visualDescription', () => {
  it('k. uses name as default, respects explicit visualDescription', () => {
    const own = makeOwnShip();
    const def: ScenarioContact = {
      id: 'x',
      trackId: 'S-01',
      name: 'Fishing dhow',
      domain: 'surface',
      truth: 'civil',
      placement: { kind: 'absolute', position: { x: 1, y: 1 }, courseDeg: 0 },
      speedKts: 0,
      altitudeFt: 0,
      behavior: { kind: 'straight' },
    };

    const result = buildContact(def, own);
    expect(result.visualDescription).toBe('Fishing dhow');
    expect(result.sensors.visual).toEqual({ kind: 'none' });

    const def2: ScenarioContact = { ...def, visualDescription: 'Low-profile craft' };
    const result2 = buildContact(def2, own);
    expect(result2.visualDescription).toBe('Low-profile craft');
  });
});
