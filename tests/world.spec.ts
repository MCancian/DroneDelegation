import { describe, expect, it } from 'vitest';
import { move } from '../src/sim/geo';
import { World, HISTORY_INTERVAL_S, HISTORY_LENGTH } from '../src/sim/world';
import type { Missile, OwnShip, RadarContact } from '../src/sim/types';
import { DEMO_CONTACTS, DEMO_OWN_SHIP } from '../src/ui/demoContacts';

function makeContact(overrides: Partial<RadarContact> = {}): RadarContact {
  return {
    id: 'test-1',
    trackId: 'T-01',
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

function makeMissile(overrides: Partial<Missile> = {}): Missile {
  return {
    id: 'm-1',
    launcherId: 'A-01',
    targetId: null,
    position: { x: 0, y: 0 },
    courseDeg: 0,
    speedKts: 0,
    altitudeFt: 0,
    alive: true,
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

describe('World', () => {
  describe('constructor deep-copies', () => {
    it('does not mutate the original init data', () => {
      const ownShip = makeOwnShip({ position: { x: 1, y: 2 }, speedKts: 10, courseDeg: 90 });
      const contact = makeContact({ position: { x: 5, y: 5 }, speedKts: 30, courseDeg: 180 });
      const init = { seed: 1, ownShip, contacts: [contact] };

      const world = new World(init);
      world.step(60);

      expect(ownShip.position).toEqual({ x: 1, y: 2 });
      expect(contact.position).toEqual({ x: 5, y: 5 });
      expect(world.contacts[0]).not.toBe(init.contacts[0]);
      expect(world.ownShip).not.toBe(init.ownShip);
    });

    it('does not mutate DEMO_CONTACTS or DEMO_OWN_SHIP', () => {
      const originalPositions = DEMO_CONTACTS.map((c) => ({ ...c.position }));
      const originalOwnPos = { ...DEMO_OWN_SHIP.position };

      const world = new World({ seed: 99, ownShip: DEMO_OWN_SHIP, contacts: DEMO_CONTACTS });
      world.step(60);

      expect(DEMO_OWN_SHIP.position).toEqual(originalOwnPos);
      for (let i = 0; i < DEMO_CONTACTS.length; i++) {
        expect(DEMO_CONTACTS[i].position).toEqual(originalPositions[i]);
      }
    });
  });

  describe('step moves entities', () => {
    it('step(60) moves own ship and contacts correctly', () => {
      const ownShip = makeOwnShip({ position: { x: 0, y: 0 }, courseDeg: 340, speedKts: 15 });
      const contact = makeContact({ position: { x: 10, y: 0 }, courseDeg: 90, speedKts: 60 });
      const world = new World({ seed: 1, ownShip, contacts: [contact] });

      world.step(60);

      const expectedOwn = move({ x: 0, y: 0 }, 340, 15, 60);
      expect(world.ownShip.position.x).toBeCloseTo(expectedOwn.x, 9);
      expect(world.ownShip.position.y).toBeCloseTo(expectedOwn.y, 9);

      const expectedContact = move({ x: 10, y: 0 }, 90, 60, 60);
      expect(world.contacts[0].position.x).toBeCloseTo(expectedContact.x, 9);
      expect(world.contacts[0].position.y).toBeCloseTo(expectedContact.y, 9);

      expect(world.time).toBe(60);
    });

    it('600 calls of step(0.1) accumulate correctly', () => {
      const contact = makeContact({ position: { x: 0, y: 0 }, courseDeg: 0, speedKts: 60 });
      const world = new World({ seed: 1, ownShip: makeOwnShip(), contacts: [contact] });

      for (let i = 0; i < 600; i++) {
        world.step(0.1);
      }

      const expected = move({ x: 0, y: 0 }, 0, 60, 60);
      expect(world.contacts[0].position.y).toBeCloseTo(expected.y, 9);
      expect(world.contacts[0].position.x).toBeCloseTo(expected.x, 9);
      expect(world.time).toBeCloseTo(60, 9);
    });

    it('dead contacts and dead missiles do not move', () => {
      const deadContact = makeContact({
        position: { x: 5, y: 5 },
        courseDeg: 90,
        speedKts: 100,
        alive: false,
      });
      const deadMissile = makeMissile({
        position: { x: 3, y: 3 },
        courseDeg: 180,
        speedKts: 600,
        alive: false,
      });
      const world = new World({
        seed: 1,
        ownShip: makeOwnShip(),
        contacts: [deadContact],
        missiles: [deadMissile],
      });

      world.step(60);

      expect(world.contacts[0].position).toEqual({ x: 5, y: 5 });
      expect(world.missiles[0].position).toEqual({ x: 3, y: 3 });
    });

    it('alive missiles move straight', () => {
      const missile = makeMissile({ position: { x: 0, y: 0 }, courseDeg: 180, speedKts: 600 });
      const world = new World({ seed: 1, ownShip: makeOwnShip(), contacts: [], missiles: [missile] });

      world.step(6);

      const expected = move({ x: 0, y: 0 }, 180, 600, 6);
      expect(world.missiles[0].position.y).toBeCloseTo(expected.y, 9);
      expect(world.missiles[0].position.y).toBeCloseTo(-1, 9);
    });
  });

  describe('step ignores invalid dt', () => {
    it('step(0), step(-1), step(NaN) change nothing', () => {
      const contact = makeContact({ position: { x: 7, y: 8 }, speedKts: 100, courseDeg: 45 });
      const world = new World({ seed: 1, ownShip: makeOwnShip({ position: { x: 1, y: 1 } }), contacts: [contact] });

      world.step(0);
      world.step(-1);
      world.step(NaN);

      expect(world.time).toBe(0);
      expect(world.contacts[0].position).toEqual({ x: 7, y: 8 });
      expect(world.ownShip.position).toEqual({ x: 1, y: 1 });
    });
  });

  describe('history trail', () => {
    it('accumulates history at HISTORY_INTERVAL_S intervals', () => {
      const contact = makeContact({ position: { x: 0, y: 0 }, courseDeg: 0, speedKts: 60 });
      const world = new World({ seed: 1, ownShip: makeOwnShip(), contacts: [contact] });

      world.step(29);
      expect(world.contacts[0].history.length).toBe(0);

      world.step(1);
      expect(world.contacts[0].history.length).toBe(1);
      expect(world.contacts[0].history[0]).toEqual(world.contacts[0].position);

      for (let i = 0; i < 10; i++) {
        world.step(30);
      }

      expect(world.contacts[0].history.length).toBe(HISTORY_LENGTH);
      expect(world.contacts[0].history[world.contacts[0].history.length - 1]).toEqual(
        world.contacts[0].position,
      );
    });

    it('history entries are copies, not references to position', () => {
      const contact = makeContact({ position: { x: 0, y: 0 }, courseDeg: 0, speedKts: 60 });
      const world = new World({ seed: 1, ownShip: makeOwnShip(), contacts: [contact] });

      world.step(HISTORY_INTERVAL_S);

      expect(world.contacts[0].history.length).toBe(1);
      expect(world.contacts[0].history[0]).not.toBe(world.contacts[0].position);
      expect(world.contacts[0].history[0]).toEqual(world.contacts[0].position);
    });
  });

  describe('logEvent', () => {
    it('creates and stores a typed event', () => {
      const world = new World({ seed: 1, ownShip: makeOwnShip(), contacts: [] });
      world.step(5);

      const event = world.logEvent('test', 'player', { a: 1 });

      expect(event).toEqual({ t: 5, type: 'test', actor: 'player', payload: { a: 1 } });
      expect(world.events.length).toBe(1);
      expect(world.events[0]).toBe(event);
    });
  });

  describe('rng determinism', () => {
    it('same seed produces same sequence', () => {
      const w1 = new World({ seed: 42, ownShip: makeOwnShip(), contacts: [] });
      const w2 = new World({ seed: 42, ownShip: makeOwnShip(), contacts: [] });

      expect(w1.rng.next()).toBe(w2.rng.next());
      expect(w1.rng.next()).toBe(w2.rng.next());
      expect(w1.rng.next()).toBe(w2.rng.next());
    });

    it('different seeds produce different sequences', () => {
      const w1 = new World({ seed: 42, ownShip: makeOwnShip(), contacts: [] });
      const w2 = new World({ seed: 43, ownShip: makeOwnShip(), contacts: [] });

      const seq1 = [w1.rng.next(), w1.rng.next(), w1.rng.next()];
      const seq2 = [w2.rng.next(), w2.rng.next(), w2.rng.next()];

      expect(seq1).not.toEqual(seq2);
    });
  });

  describe('contactById', () => {
    it('finds a contact by id', () => {
      const c1 = makeContact({ id: 'A-01' });
      const c2 = makeContact({ id: 'S-07' });
      const world = new World({ seed: 1, ownShip: makeOwnShip(), contacts: [c1, c2] });

      expect(world.contactById('A-01')).toBe(world.contacts[0]);
      expect(world.contactById('S-07')).toBe(world.contacts[1]);
    });

    it('returns undefined for unknown ids', () => {
      const world = new World({ seed: 1, ownShip: makeOwnShip(), contacts: [makeContact({ id: 'A-01' })] });

      expect(world.contactById('X-99')).toBeUndefined();
    });
  });
});
