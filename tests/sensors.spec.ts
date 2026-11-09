import { describe, expect, it } from 'vitest';
import { move, fromBearingRange, rangeTo } from '../src/sim/geo';
import { mulberry32 } from '../src/sim/rng';
import {
  DEFAULT_SENSOR_CONFIG,
  TRACK_HISTORY_INTERVAL_S,
  TRACK_HISTORY_LENGTH,
  createSensorState,
  detectionRangeNm,
  inVisualRange,
  isDetectedOnSweep,
  sweep,
  displayedPosition,
  visibleTracks,
  trackPrefix,
} from '../src/sim/sensors';
import type { Contact, OwnShip, Vec2 } from '../src/sim/types';

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

describe('detectionRangeNm', () => {
  it('air returns 90', () => {
    const c = makeContact({ domain: 'air' });
    expect(detectionRangeNm(c)).toBe(90);
  });

  it('surface default (no size) returns 20', () => {
    const c = makeContact({ domain: 'surface' });
    expect(detectionRangeNm(c)).toBe(20);
  });

  it('surface size small returns 9', () => {
    const c = makeContact({ domain: 'surface', size: 'small' });
    expect(detectionRangeNm(c)).toBe(9);
  });

  it('missile returns 30', () => {
    const c = makeContact({ domain: 'missile' });
    expect(detectionRangeNm(c)).toBe(30);
  });
});

describe('detection respects ranges', () => {
  it('air at 89 nm detected, at 91 nm not', () => {
    const ownShip = makeOwnShip();
    const rng = mulberry32(1);

    const near = makeContact({ id: 'near', domain: 'air', position: fromBearingRange({ x: 0, y: 0 }, 0, 89) });
    const far = makeContact({ id: 'far', domain: 'air', position: fromBearingRange({ x: 0, y: 0 }, 0, 91) });

    const stateNear = createSensorState();
    sweep(stateNear, [near], ownShip, 0, rng);
    expect(visibleTracks(stateNear, [near], 0).length).toBe(1);

    const stateFar = createSensorState();
    sweep(stateFar, [far], ownShip, 0, rng);
    expect(visibleTracks(stateFar, [far], 0).length).toBe(0);
  });

  it('surface ship at 19.9 detected, 20.1 not', () => {
    const ownShip = makeOwnShip();
    const rng = mulberry32(1);

    const near = makeContact({ id: 'near', domain: 'surface', position: fromBearingRange({ x: 0, y: 0 }, 0, 19.9) });
    const far = makeContact({ id: 'far', domain: 'surface', position: fromBearingRange({ x: 0, y: 0 }, 0, 20.1) });

    const stateNear = createSensorState();
    sweep(stateNear, [near], ownShip, 0, rng);
    expect(visibleTracks(stateNear, [near], 0).length).toBe(1);

    const stateFar = createSensorState();
    sweep(stateFar, [far], ownShip, 0, rng);
    expect(visibleTracks(stateFar, [far], 0).length).toBe(0);
  });

  it('small craft at 8.9 detected, 9.1 not', () => {
    const ownShip = makeOwnShip();
    const rng = mulberry32(1);

    const near = makeContact({ id: 'near', domain: 'surface', size: 'small', position: fromBearingRange({ x: 0, y: 0 }, 0, 8.9) });
    const far = makeContact({ id: 'far', domain: 'surface', size: 'small', position: fromBearingRange({ x: 0, y: 0 }, 0, 9.1) });

    const stateNear = createSensorState();
    sweep(stateNear, [near], ownShip, 0, rng);
    expect(visibleTracks(stateNear, [near], 0).length).toBe(1);

    const stateFar = createSensorState();
    sweep(stateFar, [far], ownShip, 0, rng);
    expect(visibleTracks(stateFar, [far], 0).length).toBe(0);
  });

  it('not alive is never detected', () => {
    const ownShip = makeOwnShip();
    const rng = mulberry32(1);
    const c = makeContact({ id: 'dead', domain: 'air', alive: false, position: fromBearingRange({ x: 0, y: 0 }, 0, 10) });

    const state = createSensorState();
    sweep(state, [c], ownShip, 0, rng);
    expect(visibleTracks(state, [c], 0).length).toBe(0);
  });
});

describe('low-RCS detection frequency', () => {
  function runLowRcsSweeps(seed: number, pDetect: number | undefined, sweeps: number): number {
    const ownShip = makeOwnShip();
    const rng = mulberry32(seed);
    const contact = makeContact({
      id: 'low',
      domain: 'surface',
      size: 'small',
      rcs: 'low',
      pDetect,
      position: fromBearingRange({ x: 0, y: 0 }, 0, 5),
    });
    const state = createSensorState();
    let hits = 0;
    for (let i = 0; i < sweeps; i++) {
      const t = 4 * i;
      sweep(state, [contact], ownShip, t, rng);
      if (state.tracks['low'] && state.tracks['low'].lastSeen === t) {
        hits++;
      }
    }
    return hits;
  }

  it('pDetect 0.6 seed 12345 gives fraction within 0.04 of 0.6', () => {
    const hits = runLowRcsSweeps(12345, undefined, 2000);
    const fraction = hits / 2000;
    expect(Math.abs(fraction - 0.6)).toBeLessThan(0.04);
  });

  it('pDetect 0.6 seed 7 gives fraction within 0.04 of 0.6', () => {
    const hits = runLowRcsSweeps(7, undefined, 2000);
    const fraction = hits / 2000;
    expect(Math.abs(fraction - 0.6)).toBeLessThan(0.04);
  });

  it('pDetect 0.2 seed 12345 gives fraction within 0.04 of 0.2', () => {
    const hits = runLowRcsSweeps(12345, 0.2, 2000);
    const fraction = hits / 2000;
    expect(Math.abs(fraction - 0.2)).toBeLessThan(0.04);
  });

  it('inside visual range (2 nm) low-RCS detected every sweep', () => {
    const ownShip = makeOwnShip();
    const rng = mulberry32(99);
    const contact = makeContact({
      id: 'vis',
      domain: 'surface',
      size: 'small',
      rcs: 'low',
      pDetect: 0,
      position: fromBearingRange({ x: 0, y: 0 }, 0, 2),
    });
    const state = createSensorState();
    for (let i = 0; i < 200; i++) {
      sweep(state, [contact], ownShip, 4 * i, rng);
    }
    expect(state.tracks['vis'].lastSeen).toBe(4 * 199);
    expect(state.tracks['vis'].faded).toBe(false);
  });
});

describe('faded and coasting', () => {
  it('track fades on miss and coasts on last measured course/speed', () => {
    const ownShip = makeOwnShip();
    const rng = mulberry32(1);
    const startPos = fromBearingRange({ x: 0, y: 0 }, 0, 5);
    const contact = makeContact({
      id: 'coast',
      domain: 'surface',
      size: 'small',
      rcs: 'low',
      pDetect: 1,
      position: { ...startPos },
      courseDeg: 90,
      speedKts: 30,
    });

    const state = createSensorState();

    // First sweep: detected
    sweep(state, [contact], ownShip, 0, rng);
    expect(state.tracks['coast'].detected).toBe(true);
    expect(state.tracks['coast'].faded).toBe(false);

    // Set pDetect to 0 so future sweeps miss
    contact.pDetect = 0;

    // Move contact 4s and sweep at t=4
    contact.position = move(startPos, 90, 30, 4);
    sweep(state, [contact], ownShip, 4, rng);
    expect(state.tracks['coast'].faded).toBe(true);
    expect(state.tracks['coast'].detected).toBe(true);

    // Move contact another 4s and sweep at t=8
    contact.position = move(startPos, 90, 30, 8);
    sweep(state, [contact], ownShip, 8, rng);
    expect(state.tracks['coast'].faded).toBe(true);
    expect(state.tracks['coast'].detected).toBe(true);

    // Displayed position at t=8 should be dead-reckoned from first measurement
    const displayed = displayedPosition(state.tracks['coast'], 8);
    const expected = move(startPos, 90, 30, 8);
    expect(displayed.x).toBeCloseTo(expected.x, 9);
    expect(displayed.y).toBeCloseTo(expected.y, 9);

    // Still visible in visibleTracks
    const vt = visibleTracks(state, [contact], 8);
    expect(vt.length).toBe(1);
    expect(vt[0].faded).toBe(true);

    // Re-detect: set pDetect=1, move to true position, sweep at t=12
    contact.pDetect = 1;
    contact.position = move(startPos, 90, 30, 12);
    sweep(state, [contact], ownShip, 12, rng);
    expect(state.tracks['coast'].faded).toBe(false);
    expect(state.tracks['coast'].detected).toBe(true);

    const displayedAfter = displayedPosition(state.tracks['coast'], 12);
    expect(displayedAfter.x).toBeCloseTo(contact.position.x, 9);
    expect(displayedAfter.y).toBeCloseTo(contact.position.y, 9);
  });
});

describe('dropAfterS', () => {
  it('track dropped after dropAfterS, re-detected with same trackId', () => {
    const ownShip = makeOwnShip();
    const rng = mulberry32(1);
    const contact = makeContact({
      id: 'drop',
      domain: 'surface',
      size: 'small',
      rcs: 'low',
      pDetect: 1,
      position: fromBearingRange({ x: 0, y: 0 }, 0, 5),
    });

    const state = createSensorState();

    // First sweep: detected
    sweep(state, [contact], ownShip, 0, rng);
    const originalTrackId = state.tracks['drop'].trackId;
    expect(originalTrackId).toBeTruthy();

    // Set pDetect to 0
    contact.pDetect = 0;

    // Sweep every 4s up to t=60
    for (let t = 4; t <= 60; t += 4) {
      sweep(state, [contact], ownShip, t, rng);
    }
    // At t=60: timeS - lastSeen = 60 - 0 = 60, not > 60, so still detected
    expect(state.tracks['drop'].detected).toBe(true);
    expect(visibleTracks(state, [contact], 60).length).toBe(1);

    // Sweep at t=64: 64 - 0 = 64 > 60, dropped
    sweep(state, [contact], ownShip, 64, rng);
    expect(state.tracks['drop'].detected).toBe(false);
    expect(visibleTracks(state, [contact], 64).length).toBe(0);

    // Re-detect with pDetect=1
    contact.pDetect = 1;
    sweep(state, [contact], ownShip, 68, rng);
    expect(state.tracks['drop'].detected).toBe(true);
    expect(state.tracks['drop'].trackId).toBe(originalTrackId);
    expect(visibleTracks(state, [contact], 68).length).toBe(1);
  });
});

describe('visibleTracks hides undetected truth', () => {
  it('only detected contacts appear, returned objects are independent copies', () => {
    const ownShip = makeOwnShip();
    const rng = mulberry32(1);

    const far = makeContact({
      id: 'far',
      domain: 'air',
      position: fromBearingRange({ x: 0, y: 0 }, 0, 120),
      motion: { behavior: { kind: 'straight' } },
    });
    const near = makeContact({
      id: 'near',
      domain: 'air',
      position: fromBearingRange({ x: 0, y: 0 }, 0, 50),
      motion: { behavior: { kind: 'straight' } },
    });
    const ship = makeContact({
      id: 'ship',
      domain: 'surface',
      position: fromBearingRange({ x: 0, y: 0 }, 0, 30),
      motion: { behavior: { kind: 'straight' } },
    });

    const contacts = [far, near, ship];
    const state = createSensorState();
    sweep(state, contacts, ownShip, 0, rng);

    const vt = visibleTracks(state, contacts, 0);
    expect(vt.length).toBe(1);
    expect(vt[0].id).toBe('near');

    // Not the same object as truth
    expect(vt[0]).not.toBe(near);

    // No motion property
    expect('motion' in vt[0]).toBe(false);

    // Mutating returned object does not affect truth
    const origSpeed = near.speedKts;
    vt[0].speedKts = 999;
    expect(near.speedKts).toBe(origSpeed);
  });
});

describe('track IDs assigned at first detection', () => {
  it('auto-assigned in detection order', () => {
    const ownShip = makeOwnShip();
    const rng = mulberry32(1);

    const airNear = makeContact({ id: 'air1', domain: 'air', trackId: '', position: fromBearingRange({ x: 0, y: 0 }, 0, 50) });
    const surfNear = makeContact({ id: 'surf1', domain: 'surface', trackId: '', position: fromBearingRange({ x: 0, y: 0 }, 0, 10) });
    const airFar = makeContact({ id: 'air2', domain: 'air', trackId: '', position: fromBearingRange({ x: 0, y: 0 }, 0, 100) });

    const state = createSensorState();
    sweep(state, [airNear, surfNear, airFar], ownShip, 0, rng);

    expect(state.tracks['air1'].trackId).toBe('A-01');
    expect(state.tracks['surf1'].trackId).toBe('S-01');
    expect(state.tracks['air2']).toBeUndefined();

    // Move far air to 80 nm and sweep at t=4
    airFar.position = fromBearingRange({ x: 0, y: 0 }, 0, 80);
    sweep(state, [airNear, surfNear, airFar], ownShip, 4, rng);
    expect(state.tracks['air2'].trackId).toBe('A-02');
  });

  it('preset trackId already used gets next free number', () => {
    const ownShip = makeOwnShip();
    const rng = mulberry32(1);

    // First, create a track that auto-gets A-02
    const air1 = makeContact({ id: 'a1', domain: 'air', trackId: '', position: fromBearingRange({ x: 0, y: 0 }, 0, 50) });
    const air2 = makeContact({ id: 'a2', domain: 'air', trackId: '', position: fromBearingRange({ x: 0, y: 0 }, 0, 50) });

    const state = createSensorState();
    sweep(state, [air1, air2], ownShip, 0, rng);
    expect(state.tracks['a1'].trackId).toBe('A-01');
    expect(state.tracks['a2'].trackId).toBe('A-02');

    // Now a contact with preset trackId 'A-02' is detected
    const air3 = makeContact({ id: 'a3', domain: 'air', trackId: 'A-02', position: fromBearingRange({ x: 0, y: 0 }, 0, 50) });
    sweep(state, [air1, air2, air3], ownShip, 4, rng);
    expect(state.tracks['a3'].trackId).toBe('A-03');
  });

  it('preset trackId S-7 detected first keeps S-7', () => {
    const ownShip = makeOwnShip();
    const rng = mulberry32(1);

    const s7 = makeContact({ id: 's7', domain: 'surface', trackId: 'S-7', position: fromBearingRange({ x: 0, y: 0 }, 0, 5) });
    const state = createSensorState();
    sweep(state, [s7], ownShip, 0, rng);
    expect(state.tracks['s7'].trackId).toBe('S-7');
  });
});

describe('track history', () => {
  it('at most TRACK_HISTORY_LENGTH entries, consecutive entries >= 30s apart', () => {
    const ownShip = makeOwnShip();
    const rng = mulberry32(1);
    const contact = makeContact({
      id: 'hist',
      domain: 'air',
      position: { x: 0, y: 0 },
      courseDeg: 0,
      speedKts: 360,
    });

    const state = createSensorState();

    // Sweep every 4s for 300s (75 sweeps)
    for (let i = 0; i <= 75; i++) {
      const t = 4 * i;
      contact.position = move({ x: 0, y: 0 }, 0, 360, t);
      sweep(state, [contact], ownShip, t, rng);
    }

    const track = state.tracks['hist'];
    expect(track.history.length).toBeLessThanOrEqual(TRACK_HISTORY_LENGTH);

    // Consecutive y values differ by >= 3 nm - 1e-9
    // 360 kts = 0.1 nm/s, entries are >= 30s apart, so >= 3 nm
    for (let i = 1; i < track.history.length; i++) {
      const dy = track.history[i].y - track.history[i - 1].y;
      expect(dy).toBeGreaterThanOrEqual(3 - 1e-9);
    }
  });
});

describe('trackPrefix', () => {
  it('air → A, surface → S, missile → M', () => {
    expect(trackPrefix('air')).toBe('A');
    expect(trackPrefix('surface')).toBe('S');
    expect(trackPrefix('missile')).toBe('M');
  });
});

describe('inVisualRange', () => {
  it('true at 2 nm, false at 4 nm', () => {
    const ownShip = makeOwnShip();
    const near = makeContact({ position: fromBearingRange({ x: 0, y: 0 }, 0, 2) });
    const far = makeContact({ position: fromBearingRange({ x: 0, y: 0 }, 0, 4) });
    expect(inVisualRange(ownShip, near)).toBe(true);
    expect(inVisualRange(ownShip, far)).toBe(false);
  });
});
