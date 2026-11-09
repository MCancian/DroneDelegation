import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { fromBearingRange, rangeTo } from '../src/sim/geo';
import { mulberry32 } from '../src/sim/rng';
import type { OwnShip, RadarContact } from '../src/sim/types';

function makeContact(overrides: Partial<RadarContact> = {}): RadarContact {
  return {
    id: 'test-1',
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

describe('World sensors integration', () => {
  describe('initial sweep', () => {
    it('detects contacts in range at construction and assigns track ids', () => {
      const near = makeContact({
        id: 'near',
        domain: 'air',
        position: fromBearingRange({ x: 0, y: 0 }, 45, 50),
      });
      const far = makeContact({
        id: 'far',
        domain: 'air',
        position: fromBearingRange({ x: 0, y: 0 }, 0, 120),
        courseDeg: 180,
        speedKts: 600,
      });

      const world = new World({
        seed: 1,
        ownShip: makeOwnShip(),
        contacts: [near, far],
      });

      const tracks = world.visibleTracks();
      expect(tracks).toHaveLength(1);
      expect(tracks[0].id).toBe('near');
      expect(tracks[0].trackId).toBe('A-01');
      expect(world.trackFor('far')).toBeUndefined();
    });
  });

  describe('far contact flies into range', () => {
    it('becomes visible when it crosses the detection boundary', () => {
      const far = makeContact({
        id: 'far',
        domain: 'air',
        position: fromBearingRange({ x: 0, y: 0 }, 0, 120),
        courseDeg: 180,
        speedKts: 600,
      });

      const world = new World({
        seed: 1,
        ownShip: makeOwnShip(),
        contacts: [far],
      });

      // At t=176: range = 120 - 176*(600/3600) = 120 - 29.33 = 90.67 > 90, not detected
      for (let i = 0; i < 1760; i++) {
        world.step(0.1);
      }
      expect(world.trackFor('far')).toBeUndefined();

      // At t=184: range = 120 - 184*(600/3600) = 120 - 30.67 = 89.33 < 90, detected
      for (let i = 0; i < 80; i++) {
        world.step(0.1);
      }
      const track = world.trackFor('far');
      expect(track).toBeDefined();
      expect(track!.trackId).toBe('A-01');
    });

    it('assigns A-02 when A-01 is already taken', () => {
      const near = makeContact({
        id: 'near',
        domain: 'air',
        position: fromBearingRange({ x: 0, y: 0 }, 45, 50),
      });
      const far = makeContact({
        id: 'far',
        domain: 'air',
        position: fromBearingRange({ x: 0, y: 0 }, 0, 120),
        courseDeg: 180,
        speedKts: 600,
      });

      const world = new World({
        seed: 1,
        ownShip: makeOwnShip(),
        contacts: [near, far],
      });

      // Step until far enters range (t=184)
      for (let i = 0; i < 1840; i++) {
        world.step(0.1);
      }

      const track = world.trackFor('far');
      expect(track).toBeDefined();
      expect(track!.trackId).toBe('A-02');
    });
  });

  describe('sweep cadence', () => {
    it('lastSeen reflects the most recent sweep time', () => {
      const contact = makeContact({
        id: 'c1',
        domain: 'air',
        position: fromBearingRange({ x: 0, y: 0 }, 0, 50),
      });

      const world = new World({
        seed: 1,
        ownShip: makeOwnShip(),
        contacts: [contact],
      });

      // 100 steps of 0.1s = t=10. Sweeps at t=0,4,8. Last sweep at t=8.
      for (let i = 0; i < 100; i++) {
        world.step(0.1);
      }
      expect(world.trackFor('c1')!.lastSeen).toBeCloseTo(8, 6);
    });

    it('step(60) from fresh world gives lastSeen close to 60', () => {
      const contact = makeContact({
        id: 'c1',
        domain: 'air',
        position: fromBearingRange({ x: 0, y: 0 }, 0, 50),
      });

      const world = new World({
        seed: 1,
        ownShip: makeOwnShip(),
        contacts: [contact],
      });

      world.step(60);
      expect(world.trackFor('c1')!.lastSeen).toBeCloseTo(60, 6);
    });
  });

  describe('kinematics wired in', () => {
    it('closeOnOwnship converges and sets speed', () => {
      const ownShip = makeOwnShip({ courseDeg: 340, speedKts: 15 });
      const contact = makeContact({
        id: 's7',
        domain: 'surface',
        position: fromBearingRange({ x: 0, y: 0 }, 70, 6.5),
        courseDeg: 250,
        speedKts: 0,
        motion: { behavior: { kind: 'closeOnOwnship', speedKts: 40 } },
      });

      const world = new World({ seed: 1, ownShip, contacts: [contact] });

      for (let i = 0; i < 3000; i++) {
        world.step(0.1);
      }

      const truth = world.contacts[0];
      expect(rangeTo(truth.position, world.ownShip.position)).toBeLessThan(4);
      expect(truth.speedKts).toBe(40);
    });

    it('turnAway changes course to target', () => {
      const contact = makeContact({
        id: 'a1',
        domain: 'air',
        position: { x: 0, y: 30 },
        courseDeg: 0,
        speedKts: 300,
        motion: { behavior: { kind: 'turnAway', courseDeg: 90 } },
      });

      const world = new World({ seed: 1, ownShip: makeOwnShip(), contacts: [contact] });

      for (let i = 0; i < 600; i++) {
        world.step(0.1);
      }

      expect(world.contacts[0].courseDeg).toBeCloseTo(90, 1);
    });
  });

  describe('visibleTracks hides undetected truth', () => {
    it('low-RCS craft with pDetect 0 is never visible; normal ship always is', () => {
      const lowCraft = makeContact({
        id: 'low',
        domain: 'surface',
        size: 'small',
        rcs: 'low',
        pDetect: 0,
        position: fromBearingRange({ x: 0, y: 0 }, 90, 5),
      });
      const ship = makeContact({
        id: 'ship',
        domain: 'surface',
        size: 'ship',
        position: fromBearingRange({ x: 0, y: 0 }, 270, 15),
      });

      const world = new World({
        seed: 1,
        ownShip: makeOwnShip(),
        contacts: [lowCraft, ship],
      });

      for (let i = 0; i < 1200; i++) {
        world.step(0.1);
        const tracks = world.visibleTracks();
        const ids = tracks.map((t) => t.id);
        expect(ids).not.toContain('low');
        expect(ids).toContain('ship');
      }

      // Verify the visible ship object is a clone without motion
      const tracks = world.visibleTracks();
      const visibleShip = tracks.find((t) => t.id === 'ship')!;
      expect(visibleShip).not.toBe(world.contacts[1]);
      expect('motion' in visibleShip).toBe(false);
    });
  });

  describe('low-RCS flicker in the World', () => {
    it('detection frequency approximates pDetect and faded occurs', () => {
      const craft = makeContact({
        id: 'flicker',
        domain: 'surface',
        size: 'small',
        rcs: 'low',
        position: fromBearingRange({ x: 0, y: 0 }, 90, 5),
      });

      const world = new World({
        seed: 2024,
        ownShip: makeOwnShip(),
        contacts: [craft],
      });

      let hits = 0;
      let fadedCount = 0;

      // Initial sweep at t=0
      const initialTrack = world.trackFor('flicker');
      if (initialTrack && initialTrack.lastSeen === 0) {
        hits++;
      }

      let prevLastSeen = initialTrack?.lastSeen ?? -1;

      for (let i = 0; i < 9000; i++) {
        world.step(0.1);
        const track = world.trackFor('flicker');
        if (track) {
          if (track.lastSeen !== prevLastSeen) {
            hits++;
            prevLastSeen = track.lastSeen;
          }
          if (track.faded) {
            fadedCount++;
          }
        }
      }

      // 226 total sweeps (initial at t=0 + 225 during stepping at t=4..900)
      expect(Math.abs(hits / 226 - 0.6)).toBeLessThan(0.12);
      expect(fadedCount).toBeGreaterThan(0);
    });
  });

  describe('determinism', () => {
    it('two worlds with same seed produce identical visibleTracks and truth positions', () => {
      function makeWorld(): World {
        const loiter = makeContact({
          id: 'loiter',
          domain: 'surface',
          size: 'small',
          position: { x: 3, y: 3 },
          motion: {
            behavior: { kind: 'loiter', center: { x: 3, y: 3 }, radiusNm: 1, speedKts: 5 },
          },
        });
        const lowCraft = makeContact({
          id: 'low',
          domain: 'surface',
          size: 'small',
          rcs: 'low',
          position: fromBearingRange({ x: 0, y: 0 }, 90, 6),
        });
        return new World({
          seed: 99,
          ownShip: makeOwnShip(),
          contacts: [loiter, lowCraft],
        });
      }

      const w1 = makeWorld();
      const w2 = makeWorld();

      for (let i = 0; i < 3000; i++) {
        w1.step(0.1);
        w2.step(0.1);
      }

      expect(w1.visibleTracks()).toEqual(w2.visibleTracks());
      expect(w1.contacts.map((c) => c.position)).toEqual(w2.contacts.map((c) => c.position));
    });

    it('public rng is unaffected by stepping', () => {
      const loiter = makeContact({
        id: 'loiter',
        domain: 'surface',
        size: 'small',
        position: { x: 3, y: 3 },
        motion: {
          behavior: { kind: 'loiter', center: { x: 3, y: 3 }, radiusNm: 1, speedKts: 5 },
        },
      });
      const lowCraft = makeContact({
        id: 'low',
        domain: 'surface',
        size: 'small',
        rcs: 'low',
        position: fromBearingRange({ x: 0, y: 0 }, 90, 6),
      });

      const world = new World({
        seed: 99,
        ownShip: makeOwnShip(),
        contacts: [loiter, lowCraft],
      });

      for (let i = 0; i < 1000; i++) {
        world.step(0.1);
      }

      const expected = mulberry32(99).next();
      expect(world.rng.next()).toBe(expected);
    });
  });
});
