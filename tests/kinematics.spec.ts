import { describe, expect, it } from 'vitest';
import {
  move,
  rangeTo,
  bearingTo,
  fromBearingRange,
} from '../src/sim/geo';
import { mulberry32 } from '../src/sim/rng';
import {
  DEFAULT_TURN_RATE_DEG_PER_SEC,
  turnRadiusNm,
  turnToward,
  leadPursuitCourse,
  setBehavior,
  stepKinematics,
} from '../src/sim/kinematics';
import type { Contact, OwnShip } from '../src/sim/types';

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
    courseDeg: 340,
    speedKts: 15,
    hullPct: 100,
    inventory: { sam: 24, chaff: 6, gunBursts: 40, ciws: 1000 },
    ...overrides,
  };
}

describe('turnToward', () => {
  it('350 toward 10 at rate 3 dt 1 gives 353', () => {
    expect(turnToward(350, 10, 3, 1)).toBe(353);
  });

  it('10 toward 350 at rate 3 dt 1 gives 7', () => {
    expect(turnToward(10, 350, 3, 1)).toBe(7);
  });

  it('0 toward 2 at rate 3 dt 1 gives 2 (within maxStep)', () => {
    expect(turnToward(0, 2, 3, 1)).toBe(2);
  });

  it('90 toward 270 (exactly opposite) gives 87 or 93', () => {
    const result = turnToward(90, 270, 3, 1);
    expect(result === 87 || result === 93).toBe(true);
  });
});

describe('no motion (undefined motion)', () => {
  it('moves straight: course 90 speed 360 for 10s gives x≈1, y≈0', () => {
    const contact = makeContact({ courseDeg: 90, speedKts: 360 });
    const ownShip = makeOwnShip();
    const rng = mulberry32(1);
    const dt = 0.1;
    for (let i = 0; i < 100; i++) {
      stepKinematics(contact, ownShip, (i + 1) * dt, dt, rng);
    }
    expect(contact.position.x).toBeCloseTo(1.0, 6);
    expect(contact.position.y).toBeCloseTo(0, 6);
  });
});

describe('straight behavior', () => {
  it('turns toward courseDeg 180 at rate-limited speed', () => {
    const contact = makeContact({
      courseDeg: 0,
      speedKts: 300,
      motion: { behavior: { kind: 'straight', courseDeg: 180 } },
    });
    const ownShip = makeOwnShip();
    const rng = mulberry32(1);
    const dt = 0.1;
    const courses: number[] = [];
    for (let i = 0; i < 1200; i++) {
      stepKinematics(contact, ownShip, (i + 1) * dt, dt, rng);
      courses.push(contact.courseDeg);
    }
    // Per-step change <= 0.3 + 1e-9
    for (let i = 1; i < courses.length; i++) {
      const diff = Math.abs(courses[i] - courses[i - 1]);
      // Handle wrap-around
      const wrapped = Math.min(diff, 360 - diff);
      expect(wrapped).toBeLessThanOrEqual(0.3 + 1e-9);
    }
    expect(contact.courseDeg).toBe(180);
  });
});

describe('waypoints behavior', () => {
  it('reaches each waypoint within arrive radius', () => {
    const points = [
      { x: 0, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
    ];
    const speed = 300;
    const rate = 3;
    const arriveRadius = Math.max(0.1, 1.05 * turnRadiusNm(speed, rate));

    const contact = makeContact({
      position: { x: 0, y: 0 },
      courseDeg: 0,
      speedKts: speed,
      motion: {
        behavior: { kind: 'waypoints', points, speedKts: speed, turnRateDegPerSec: rate },
      },
    });
    const ownShip = makeOwnShip();
    const rng = mulberry32(1);
    const dt = 0.1;

    const minRanges = [Infinity, Infinity, Infinity];
    const courses: number[] = [];

    for (let i = 0; i < 15000; i++) {
      stepKinematics(contact, ownShip, (i + 1) * dt, dt, rng);
      courses.push(contact.courseDeg);

      const state = contact.motion!.state!;
      if (!state.waypointsDone && state.waypointIndex < points.length) {
        const r = rangeTo(contact.position, points[state.waypointIndex]);
        if (r < minRanges[state.waypointIndex]) {
          minRanges[state.waypointIndex] = r;
        }
      }
    }

    expect(contact.motion!.state!.waypointsDone).toBe(true);
    for (let i = 0; i < points.length; i++) {
      expect(minRanges[i]).toBeLessThanOrEqual(arriveRadius + 1e-9);
    }

    // Per-step course change <= 0.3 + 1e-9
    for (let i = 1; i < courses.length; i++) {
      const diff = Math.abs(courses[i] - courses[i - 1]);
      const wrapped = Math.min(diff, 360 - diff);
      expect(wrapped).toBeLessThanOrEqual(0.3 + 1e-9);
    }
  });
});

describe('closeOnOwnship behavior', () => {
  it('pure pursuit converges', () => {
    const startPos = fromBearingRange({ x: 0, y: 0 }, 70, 6.5);
    const contact = makeContact({
      domain: 'surface',
      position: startPos,
      courseDeg: 250,
      speedKts: 0,
      motion: { behavior: { kind: 'closeOnOwnship', speedKts: 40, mode: 'pure' } },
    });
    const ownShip = makeOwnShip({ position: { x: 0, y: 0 }, courseDeg: 340, speedKts: 15 });
    const rng = mulberry32(1);
    const dt = 0.1;

    const startRange = rangeTo(contact.position, ownShip.position);
    let converged = false;
    let rangeAt60s = Infinity;

    for (let i = 0; i < 15000; i++) {
      const t = (i + 1) * dt;
      ownShip.position = move(ownShip.position, ownShip.courseDeg, ownShip.speedKts, dt);
      stepKinematics(contact, ownShip, t, dt, rng);

      const r = rangeTo(contact.position, ownShip.position);
      if (Math.abs(t - 60) < dt / 2) {
        rangeAt60s = r;
      }
      if (r < 0.1) {
        converged = true;
        break;
      }
    }

    expect(converged).toBe(true);
    expect(rangeAt60s).toBeLessThan(startRange);
  });

  it('lead pursuit converges', () => {
    const startPos = fromBearingRange({ x: 0, y: 0 }, 70, 6.5);
    const contact = makeContact({
      domain: 'surface',
      position: startPos,
      courseDeg: 250,
      speedKts: 0,
      motion: { behavior: { kind: 'closeOnOwnship', speedKts: 40, mode: 'lead' } },
    });
    const ownShip = makeOwnShip({ position: { x: 0, y: 0 }, courseDeg: 340, speedKts: 15 });
    const rng = mulberry32(1);
    const dt = 0.1;

    let converged = false;
    for (let i = 0; i < 15000; i++) {
      const t = (i + 1) * dt;
      ownShip.position = move(ownShip.position, ownShip.courseDeg, ownShip.speedKts, dt);
      stepKinematics(contact, ownShip, t, dt, rng);
      if (rangeTo(contact.position, ownShip.position) < 0.1) {
        converged = true;
        break;
      }
    }
    expect(converged).toBe(true);
  });
});

describe('leadPursuitCourse', () => {
  it('returns null when pursuer is slower than target running away', () => {
    const result = leadPursuitCourse({ x: 0, y: 0 }, 10, { x: 0, y: 5 }, 0, 20);
    expect(result).toBeNull();
  });

  it('returns bearing to stationary target', () => {
    const result = leadPursuitCourse({ x: 0, y: 0 }, 10, { x: 3, y: 4 }, 0, 0);
    expect(result).toBeCloseTo(36.8699, 3);
  });
});

describe('loiter behavior', () => {
  it('stays within radius, moves, and is deterministic', () => {
    const center = { x: 5, y: 5 };
    const radius = 1.5;
    const offsets = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0 },
      { x: 0, y: -0.5 },
      { x: -0.5, y: 0.3 },
      { x: 0.3, y: 0.3 },
    ];

    function runSim(): Contact[] {
      const rng = mulberry32(42);
      const ownShip = makeOwnShip({ position: { x: 0, y: 0 }, speedKts: 0, courseDeg: 0 });
      const contacts = offsets.map((off, i) =>
        makeContact({
          id: `loiter-${i}`,
          domain: 'surface',
          position: { x: center.x + off.x, y: center.y + off.y },
          courseDeg: 0,
          speedKts: 5,
          motion: {
            behavior: { kind: 'loiter', center, radiusNm: radius, speedKts: 5 },
          },
        }),
      );
      const dt = 0.1;
      for (let i = 0; i < 36000; i++) {
        for (const c of contacts) {
          stepKinematics(c, ownShip, (i + 1) * dt, dt, rng);
        }
      }
      return contacts;
    }

    const contacts = runSim();

    // All within radius at final step
    for (const c of contacts) {
      expect(rangeTo(c.position, center)).toBeLessThanOrEqual(radius + 1e-9);
    }

    // At least one moved more than 0.1 nm
    const moved = contacts.some((c, i) => {
      const start = { x: center.x + offsets[i].x, y: center.y + offsets[i].y };
      return rangeTo(c.position, start) > 0.1;
    });
    expect(moved).toBe(true);

    // Determinism
    const contacts2 = runSim();
    for (let i = 0; i < contacts.length; i++) {
      expect(contacts[i].position).toEqual(contacts2[i].position);
    }
  });

  it('stays within radius at every step', () => {
    const center = { x: 5, y: 5 };
    const radius = 1.5;
    const rng = mulberry32(42);
    const ownShip = makeOwnShip({ position: { x: 0, y: 0 }, speedKts: 0, courseDeg: 0 });
    const contact = makeContact({
      domain: 'surface',
      position: { x: 5, y: 5 },
      courseDeg: 0,
      speedKts: 5,
      motion: {
        behavior: { kind: 'loiter', center, radiusNm: radius, speedKts: 5 },
      },
    });
    const dt = 0.1;
    for (let i = 0; i < 36000; i++) {
      stepKinematics(contact, ownShip, (i + 1) * dt, dt, rng);
      expect(rangeTo(contact.position, center)).toBeLessThanOrEqual(radius + 1e-9);
    }
  });
});

describe('altitude', () => {
  it('climbs toward target altitude', () => {
    const contact = makeContact({
      altitudeFt: 5000,
      motion: {
        behavior: { kind: 'straight', targetAltitudeFt: 15000, climbRateFpm: 3000 },
      },
    });
    const ownShip = makeOwnShip();
    const rng = mulberry32(1);
    const dt = 0.1;

    // After 60s: 5000 + 3000/60*60 = 8000
    for (let i = 0; i < 600; i++) {
      stepKinematics(contact, ownShip, (i + 1) * dt, dt, rng);
    }
    expect(Math.abs(contact.altitudeFt - 8000)).toBeLessThan(1);

    // After 300s total: reaches 15000 exactly
    for (let i = 600; i < 3000; i++) {
      stepKinematics(contact, ownShip, (i + 1) * dt, dt, rng);
    }
    expect(contact.altitudeFt).toBe(15000);
  });

  it('descends toward target altitude', () => {
    const contact = makeContact({
      altitudeFt: 15000,
      motion: {
        behavior: { kind: 'straight', targetAltitudeFt: 10000, climbRateFpm: 2000 },
      },
    });
    const ownShip = makeOwnShip();
    const rng = mulberry32(1);
    const dt = 0.1;

    // After 60s: 15000 - 2000/60*60 = 13000
    for (let i = 0; i < 600; i++) {
      stepKinematics(contact, ownShip, (i + 1) * dt, dt, rng);
    }
    expect(Math.abs(contact.altitudeFt - 13000)).toBeLessThan(1);
  });
});

describe('schedule by time', () => {
  it('switches behavior at the specified time', () => {
    const contact = makeContact({
      courseDeg: 0,
      speedKts: 300,
      motion: {
        behavior: { kind: 'straight' },
        schedule: [
          { when: { kind: 'time', atS: 10 }, behavior: { kind: 'turnAway', courseDeg: 90 } },
        ],
      },
    });
    const ownShip = makeOwnShip();
    const rng = mulberry32(1);
    const dt = 0.1;

    // Step to t=9.5
    for (let i = 0; i < 95; i++) {
      stepKinematics(contact, ownShip, (i + 1) * dt, dt, rng);
    }
    expect(contact.motion!.behavior.kind).toBe('straight');
    expect(contact.courseDeg).toBe(0);

    // Step to t=60
    for (let i = 95; i < 600; i++) {
      stepKinematics(contact, ownShip, (i + 1) * dt, dt, rng);
    }
    expect(contact.motion!.behavior.kind).toBe('turnAway');
    expect(contact.motion!.schedule!.length).toBe(0);
    expect(contact.courseDeg).toBe(90);
  });
});

describe('schedule by range', () => {
  it('switches behavior when range threshold is met', () => {
    const ownShip = makeOwnShip({ position: { x: 0, y: 0 }, speedKts: 0, courseDeg: 0 });
    const contact = makeContact({
      position: { x: 0, y: 20 },
      courseDeg: 180,
      speedKts: 600,
      motion: {
        behavior: { kind: 'straight' },
        schedule: [
          {
            when: { kind: 'rangeToOwnshipBelow', rangeNm: 10 },
            behavior: { kind: 'turnAway', courseDeg: 45 },
          },
        ],
      },
    });
    const rng = mulberry32(1);
    const dt = 0.1;

    let switchRange = -1;
    let switched = false;

    for (let i = 0; i < 15000; i++) {
      const t = (i + 1) * dt;
      const prevKind = contact.motion!.behavior.kind;
      stepKinematics(contact, ownShip, t, dt, rng);
      if (!switched && contact.motion!.behavior.kind !== prevKind) {
        switchRange = rangeTo(contact.position, ownShip.position);
        // The range at the moment of switch (before this step's move) was <= 10
        // After the move it might be slightly less, but the trigger checked pre-move position
        // Actually the trigger checks contact.position which is the position at start of step
        // Let's just verify it's in range
        switched = true;
      }
    }

    expect(switched).toBe(true);
    // The range when the trigger fired should be within (9.8, 10]
    // We check the range at the step where the switch happened (post-move)
    // The pre-move range was <= 10 and > 9.8 (since previous step was > 10)
    // Post-move range is slightly less. Let's verify the pre-move range was in (9.8, 10].
    // Actually let's just re-run and capture the pre-move range.
    expect(switchRange).toBeGreaterThan(9.8 - 0.02); // allow for one step of movement
    expect(switchRange).toBeLessThanOrEqual(10 + 1e-9);

    // 120s after switch, course should be 45
    // The switch happened around t=60.1, so by t=180+ it should be at 45
    // We already stepped 15000 steps = 1500s, well past that
    expect(contact.courseDeg).toBe(45);
  });
});

describe('setBehavior', () => {
  it('resets state and keeps existing schedule', () => {
    const contact = makeContact({
      courseDeg: 90,
      motion: {
        behavior: { kind: 'straight' },
        schedule: [
          { when: { kind: 'time', atS: 100 }, behavior: { kind: 'turnAway', courseDeg: 0 } },
        ],
        state: {
          waypointIndex: 5,
          waypointsDone: true,
          loiterCourseDeg: 123,
          loiterTimerS: 999,
        },
      },
    });

    setBehavior(contact, { kind: 'waypoints', points: [{ x: 1, y: 1 }] });

    expect(contact.motion!.state!.waypointIndex).toBe(0);
    expect(contact.motion!.state!.waypointsDone).toBe(false);
    expect(contact.motion!.state!.loiterCourseDeg).toBe(90);
    expect(contact.motion!.state!.loiterTimerS).toBe(0);
    expect(contact.motion!.schedule!.length).toBe(1);
    expect(contact.motion!.schedule![0].when).toEqual({ kind: 'time', atS: 100 });
  });
});

describe('turnRadiusNm', () => {
  it('returns Infinity for zero or negative rate', () => {
    expect(turnRadiusNm(300, 0)).toBe(Infinity);
    expect(turnRadiusNm(300, -1)).toBe(Infinity);
  });

  it('computes correctly for normal values', () => {
    const r = turnRadiusNm(300, 3);
    expect(r).toBeCloseTo(1.5915, 3);
  });
});
