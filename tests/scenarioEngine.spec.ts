import { describe, expect, it, vi } from 'vitest';
import type { OwnShip } from '../src/sim/types';
import { World } from '../src/sim/world';
import {
  buildContact,
  loadScenario,
  runScenario,
  validateScenario,
  type Scenario,
  type ScenarioHooks,
} from '../src/sim/scenario/scenario';

function makeOwnShip(): OwnShip {
  return {
    position: { x: 0, y: 0 },
    courseDeg: 0,
    speedKts: 0,
    hullPct: 100,
    inventory: { sam: 24, chaff: 6, gunBursts: 40, ciws: 1000 },
  };
}

function makeScenario(): Scenario {
  return {
    id: 'test',
    name: 'Test Scenario',
    durationS: 100,
    ownShip: makeOwnShip(),
    contacts: [
      {
        id: 'tgt',
        trackId: 'A-01',
        name: 'test bomber',
        domain: 'air',
        truth: 'hostile',
        placement: { kind: 'absolute', position: { x: 0, y: 10 }, courseDeg: 180 },
        speedKts: 360,
        altitudeFt: 10000,
        behavior: { kind: 'straight' },
      },
      {
        id: 'late',
        trackId: 'A-02',
        name: 'late airliner',
        domain: 'air',
        truth: 'civil',
        placement: { kind: 'fromOwnship', bearingDeg: 90, rangeNm: 20 },
        speedKts: 0,
        altitudeFt: 30000,
        sensors: { iff: { kind: 'mode3', code: '1234' } },
        behavior: { kind: 'straight' },
        spawnAtS: 20,
      },
    ],
    triggers: [
      {
        id: 'h1',
        when: { kind: 'hostileAct', byContactId: 'tgt' },
        actions: [
          { kind: 'setBehavior', contactId: 'tgt', behavior: { kind: 'turnAway', courseDeg: 0 } },
        ],
      },
      {
        id: 't1',
        when: { kind: 'time', atS: 10 },
        actions: [
          { kind: 'crewReport', station: 'CIC', priority: 'routine', text: 'ten seconds' },
        ],
      },
      {
        id: 'r1',
        when: { kind: 'rangeBelow', contactId: 'tgt', rangeNm: 5 },
        actions: [
          {
            kind: 'launchMissiles',
            contactId: 'tgt',
            launch: { count: 2, weapon: 'ASCM', speedKts: 600, altitudeFt: 50 },
          },
        ],
      },
      {
        id: 's1',
        when: { kind: 'time', atS: 30 },
        actions: [
          {
            kind: 'setSensorInfo',
            contactId: 'late',
            sensors: { esm: { kind: 'emitter', emitterType: 'test radar' } },
          },
        ],
      },
      {
        id: 'nb',
        when: { kind: 'rangeBelow', contactId: 'late', rangeNm: 100 },
        notBeforeS: 40,
        actions: [
          { kind: 'crewReport', station: 'EW', priority: 'priority', text: 'late seen' },
        ],
      },
    ],
  };
}

describe('scenario engine', () => {
  describe('t1 crew-report fires at t ~ 10', () => {
    it('logs a crew-report event near t=10', () => {
      const { world } = runScenario(makeScenario(), 1, { untilS: 20 });
      const crewEvents = world.events.filter(
        (e) => e.type === 'crew-report' && (e.payload as Record<string, unknown>).triggerId === 't1',
      );
      expect(crewEvents.length).toBe(1);
      expect(Math.abs(crewEvents[0].t - 10)).toBeLessThanOrEqual(0.15);
      expect(crewEvents[0].payload).toMatchObject({
        station: 'CIC',
        priority: 'routine',
        text: 'ten seconds',
      });
    });
  });

  describe('late contact spawning', () => {
    it('is not in world.contacts while time < 19.95', () => {
      let lateFoundBeforeSpawn = false;
      runScenario(makeScenario(), 1, {
        untilS: 20,
        onStep: (world) => {
          if (world.time < 19.95) {
            const c = world.contactById('late');
            if (c !== undefined) lateFoundBeforeSpawn = true;
          }
        },
      });
      expect(lateFoundBeforeSpawn).toBe(false);
    });

    it('spawns at position (20, 0) with courseDeg 270 and correct sensors', () => {
      const { world } = runScenario(makeScenario(), 1, { untilS: 25 });
      const late = world.contactById('late');
      expect(late).toBeDefined();
      expect(late!.position.x).toBeCloseTo(20, 6);
      expect(late!.position.y).toBeCloseTo(0, 6);
      expect(late!.courseDeg).toBeCloseTo(270, 6);
      expect(late!.sensors.iff).toEqual({ kind: 'mode3', code: '1234' });
      expect(late!.sensors.ais).toEqual({ kind: 'none' });
      expect(late!.sensors.esm).toEqual({ kind: 'none' });
      expect(late!.sensors.visual).toEqual({ kind: 'none' });
    });
  });

  describe('missile launch and trigger ordering', () => {
    it('fires missile-launch at t ~ 50 with correct payload and trigger order', () => {
      const { world, runner } = runScenario(makeScenario(), 1, { untilS: 60 });

      const launchEvents = world.events.filter((e) => e.type === 'missile-launch');
      expect(launchEvents.length).toBe(1);
      expect(Math.abs(launchEvents[0].t - 50)).toBeLessThanOrEqual(0.15);

      const payload = launchEvents[0].payload as Record<string, unknown>;
      expect(payload.rangeNm).toBeGreaterThan(4.9);
      expect(payload.rangeNm).toBeLessThan(5.0);
      expect(payload.bearingDeg).toBeCloseTo(0, 6);
      expect(payload.count).toBe(2);
      expect(payload.launcherId).toBe('tgt');
      expect(payload.trackId).toBe('A-01');

      expect(runner.hostileActs.length).toBe(1);
      expect(runner.hostileActs[0].contactId).toBe('tgt');

      const behaviorEvents = world.events.filter((e) => e.type === 'behavior-change');
      expect(behaviorEvents.length).toBe(1);
      expect(behaviorEvents[0].t).toBe(launchEvents[0].t);

      expect(runner.firedTriggers).toEqual(['t1', 's1', 'nb', 'r1', 'h1']);
    });
  });

  describe('hooks', () => {
    it('calls custom hooks.launchMissiles exactly once with correct args', () => {
      const mockLaunch = vi.fn();
      const hooks: ScenarioHooks = { launchMissiles: mockLaunch };
      const { world } = runScenario(makeScenario(), 1, { untilS: 60, hooks });

      expect(mockLaunch).toHaveBeenCalledTimes(1);
      const [worldArg, reqArg] = mockLaunch.mock.calls[0];
      expect(worldArg).toBe(world);
      expect(reqArg.launcherId).toBe('tgt');
    });

    it('logs missile-launch event even with default (stub) hooks', () => {
      const { world } = runScenario(makeScenario(), 1, { untilS: 60 });
      const launchEvents = world.events.filter((e) => e.type === 'missile-launch');
      expect(launchEvents.length).toBe(1);
    });
  });

  describe('trigger fires once and notBeforeS', () => {
    it('exactly one missile-launch event over 100s; nb fires at t ~ 40 not ~ 20', () => {
      const { world, runner } = runScenario(makeScenario(), 1, { untilS: 100 });

      const launchEvents = world.events.filter((e) => e.type === 'missile-launch');
      expect(launchEvents.length).toBe(1);

      const nbCrewEvents = world.events.filter(
        (e) => e.type === 'crew-report' && (e.payload as Record<string, unknown>).triggerId === 'nb',
      );
      expect(nbCrewEvents.length).toBe(1);
      expect(Math.abs(nbCrewEvents[0].t - 40)).toBeLessThanOrEqual(0.15);
      expect(nbCrewEvents[0].t).toBeGreaterThan(39);
    });
  });

  describe('sensor info update visible in tracks', () => {
    it('after t=30 late has esm emitter and visibleTracks shows it', () => {
      const { world } = runScenario(makeScenario(), 1, { untilS: 35 });
      const late = world.contactById('late');
      expect(late).toBeDefined();
      expect(late!.sensors.esm).toEqual({ kind: 'emitter', emitterType: 'test radar' });

      const tracks = world.visibleTracks();
      const lateTrack = tracks.find((t) => t.id === 'late');
      expect(lateTrack).toBeDefined();
      expect(lateTrack!.sensors.esm).toEqual({ kind: 'emitter', emitterType: 'test radar' });
    });
  });

  describe('scenario data not mutated', () => {
    it('JSON.stringify of scenario is identical before and after run', () => {
      const scenario = makeScenario();
      const before = JSON.stringify(scenario);
      runScenario(scenario, 1, { untilS: 60 });
      const after = JSON.stringify(scenario);
      expect(after).toBe(before);
    });
  });

  describe('validateScenario', () => {
    it('returns [] for a valid scenario', () => {
      expect(validateScenario(makeScenario())).toEqual([]);
    });

    it('returns non-empty for duplicate contact id', () => {
      const s = makeScenario();
      s.contacts.push({ ...s.contacts[0], trackId: 'A-99' });
      expect(validateScenario(s).length).toBeGreaterThan(0);
    });

    it('returns error containing contact name for unknown reference', () => {
      const s = makeScenario();
      s.triggers.push({
        id: 'bad',
        when: { kind: 'rangeBelow', contactId: 'nope', rangeNm: 5 },
        actions: [],
      });
      const errors = validateScenario(s);
      expect(errors.some((e) => e.includes('nope'))).toBe(true);
    });

    it('loadScenario throws on invalid scenario', () => {
      const s = makeScenario();
      s.durationS = 0;
      expect(() => loadScenario(s, 1)).toThrow(/Invalid scenario/);
    });
  });

  describe('runScenario timing', () => {
    it('world.time is close to untilS after run', () => {
      const { world } = runScenario(makeScenario(), 1, { untilS: 60 });
      expect(world.time).toBeCloseTo(60, 6);
    });
  });

  describe('determinism', () => {
    it('two runs with same seed produce identical events', () => {
      const r1 = runScenario(makeScenario(), 42, { untilS: 60 });
      const r2 = runScenario(makeScenario(), 42, { untilS: 60 });
      expect(JSON.stringify(r1.world.events)).toBe(JSON.stringify(r2.world.events));
    });
  });

  describe('buildContact with explicit courseDeg on fromOwnship', () => {
    it('keeps the explicit courseDeg', () => {
      const ownShip = makeOwnShip();
      const contact = buildContact(
        {
          id: 'x',
          trackId: 'A-99',
          name: 'test',
          domain: 'air',
          truth: 'civil',
          placement: { kind: 'fromOwnship', bearingDeg: 90, rangeNm: 10, courseDeg: 45 },
          speedKts: 100,
          altitudeFt: 5000,
          behavior: { kind: 'straight' },
        },
        ownShip,
      );
      expect(contact.courseDeg).toBe(45);
    });
  });
});
