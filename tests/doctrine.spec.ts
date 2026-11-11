import { describe, expect, it } from 'vitest';
import { Doctrine } from '../src/ai/doctrine';
import type { ProposalManager } from '../src/ai/proposals';
import type { ObservedHostileAct } from '../src/ai/situation';
import type { SensorTrack } from '../src/sim/types';
import { fromBearingRange } from '../src/sim/geo';
import { makeWorld } from './helpers/sim';

const hostile: ObservedHostileAct = {
  trackId: 'A-01', t: 0, altitudeFt: 300, speedKts: 600,
  bearingDeg: 45, rangeNm: 30,
};

function track(overrides: Partial<SensorTrack> = {}): SensorTrack {
  return {
    id: 'candidate', trackId: 'A-02', domain: 'air',
    position: fromBearingRange({ x: 0, y: 0 }, 45, 39),
    courseDeg: 225, speedKts: 420, altitudeFt: 15000,
    classification: 'unknown', alive: true, history: [],
    sensors: { iff: { kind: 'none' }, ais: { kind: 'none' }, esm: { kind: 'none' }, visual: { kind: 'none' } },
    ...overrides,
  };
}

function harness(tracks: SensorTrack[], acts: ObservedHostileAct[] = [hostile]) {
  const world = makeWorld();
  Object.assign(world, { autonomy: { air: 'WEAPONS_FREE', surface: 'WEAPONS_FREE' } });
  world.visibleTracks = () => tracks;
  const proposals: { command: unknown; actor: string; reason?: string }[] = [];
  const completed = new Set<string>();
  const manager = {
    hasTarget: (id: string) => completed.has(id),
    submit: (command: { target: string }, actor: string, reason?: string) => {
      proposals.push({ command, actor, reason });
      completed.add(command.target);
    },
  } as unknown as ProposalManager;
  const doctrine = new Doctrine(world, manager, { getHostileActs: () => acts });
  return { world, doctrine, proposals, completed };
}

describe('doctrine from observed evidence', () => {
  it('logs under HOLD, then routes once after the 15-second match delay', () => {
    const air = track();
    const { world, doctrine, proposals } = harness([air]);
    world.autonomy.air = 'HOLD';
    doctrine.update();
    expect(world.events.filter((e) => e.type === 'doctrine_match')).toHaveLength(1);
    world.time = 15;
    doctrine.update();
    expect(proposals).toHaveLength(0);
    world.autonomy.air = 'WEAPONS_FREE';
    world.time = 16;
    doctrine.update();
    expect(proposals).toMatchObject([{ command: { action: 'engage_sam', target: 'candidate' }, actor: 'doctrine' }]);
    world.time = 17;
    doctrine.update();
    expect(proposals).toHaveLength(1);
  });

  it('matches the initial approach bearing regardless of altitude and speed', () => {
    const target = track({ altitudeFt: 35000, speedKts: 460, position: fromBearingRange({ x: 0, y: 0 }, 60, 39) });
    const { world, doctrine, proposals } = harness([target]);
    doctrine.update();
    expect(world.events.filter((e) => e.type === 'doctrine_match')).toHaveLength(1);
    // Subsequent bearings can change: the criterion is the initial bearing.
    target.position = fromBearingRange({ x: 0, y: 0 }, 80, 38);
    target.courseDeg = 260;
    world.time = 15;
    doctrine.update();
    expect(proposals).toHaveLength(1);
  });

  it.each([
    ['bearing beyond tolerance', { position: fromBearingRange({ x: 0, y: 0 }, 61, 39) }],
    ['sector', { position: fromBearingRange({ x: 0, y: 0 }, 19, 39) }],
    ['opening', { courseDeg: 45 }],
    ['same observed attacker', { trackId: 'A-01' }],
  ])('rejects %s outside ROE-3', (_label, change) => {
    const { world, doctrine, proposals } = harness([track(change)]);
    doctrine.update();
    world.time = 20;
    doctrine.update();
    expect(world.events.filter((e) => e.type === 'doctrine_match')).toHaveLength(0);
    expect(proposals).toHaveLength(0);
  });

  it('restarts a match after stale or missing sensor observations', () => {
    const target = track({ lastSeen: 0 });
    const { world, doctrine, proposals } = harness([target]);
    doctrine.update();
    world.time = 15;
    doctrine.update();
    expect(proposals).toHaveLength(0);
    target.lastSeen = 16;
    world.time = 16;
    doctrine.update();
    target.lastSeen = 31;
    world.time = 31;
    doctrine.update();
    expect(proposals).toHaveLength(1);
  });

  it('requires a prior group, departure, fast closing and unanswered hail for ROE-5', () => {
    const ship = track({ id: 'boat', trackId: 'S-01', domain: 'surface', position: { x: 0, y: 6.7 }, courseDeg: 180, speedKts: 4, altitudeFt: 0 });
    const neighbor = track({ id: 'neighbor', trackId: 'S-02', domain: 'surface', position: { x: 0.5, y: 6.7 }, courseDeg: 0, speedKts: 4, altitudeFt: 0 });
    const { world, doctrine, proposals } = harness([ship, neighbor], []);
    doctrine.update();
    ship.speedKts = 40;
    ship.position = { x: 0, y: 6.5 };
    world.time = 1;
    doctrine.update();
    expect(world.events.filter((e) => e.type === 'doctrine_match')).toMatchObject([{ payload: { rule: 'ROE-5', target: 'boat' } }]);
    world.time = 16;
    doctrine.update();
    expect(proposals).toMatchObject([{ command: { action: 'engage_gun', target: 'boat' }, actor: 'doctrine' }]);
  });

  it('does not match fast traffic with AIS, an answered hail, or no observed group', () => {
    const neighbor = track({ id: 'neighbor', trackId: 'S-02', domain: 'surface', position: { x: 0.5, y: 6.7 }, speedKts: 4 });
    const boat = track({ id: 'boat', trackId: 'S-01', domain: 'surface', position: { x: 0, y: 6.7 }, courseDeg: 180, speedKts: 4 });
    const { world, doctrine } = harness([boat, neighbor], []);
    doctrine.update();
    boat.speedKts = 40;
    boat.position = { x: 0, y: 6.5 };
    boat.sensors.ais = { kind: 'vessel', name: 'Ferry', vesselType: 'passenger' };
    world.time = 1;
    doctrine.update();
    expect(world.events.filter((e) => e.type === 'doctrine_match')).toHaveLength(0);
    boat.sensors.ais = { kind: 'none' };
    world.logEvent('command_response', 'player', { action: 'hail', target: 'boat', trackId: 'S-01', outcome: 'answered' });
    world.time = 2;
    doctrine.update();
    expect(world.events.filter((e) => e.type === 'doctrine_match')).toHaveLength(0);

    const isolated = track({ id: 'isolated', trackId: 'S-03', domain: 'surface', position: { x: 0, y: 6 }, courseDeg: 180, speedKts: 40 });
    const second = harness([isolated], []);
    second.doctrine.update();
    second.world.time = 20;
    second.doctrine.update();
    expect(second.world.events.filter((e) => e.type === 'doctrine_match')).toHaveLength(0);
  });

  it('resets the waiting period on a genuine rule mismatch', () => {
    const target = track();
    const { world, doctrine, proposals } = harness([target]);
    doctrine.update();
    target.speedKts = 0;
    world.time = 5;
    doctrine.update();
    target.speedKts = 420;
    world.time = 6;
    doctrine.update();
    world.time = 20;
    doctrine.update();
    expect(proposals).toHaveLength(0);
    world.time = 21;
    doctrine.update();
    expect(proposals).toHaveLength(1);
    expect(world.events.filter((event) => event.type === 'doctrine_match')).toHaveLength(2);
  });

  it('does not consult hidden contacts while evaluating observed tracks', () => {
    const { world, doctrine, proposals } = harness([track()]);
    Object.defineProperty(world, 'contacts', { get: () => { throw new Error('hidden contacts accessed'); } });
    doctrine.update();
    world.time = 15;
    doctrine.update();
    expect(proposals).toHaveLength(1);
  });

  it('does not infer a group from a stale neighboring track', () => {
    const boat = track({ id: 'boat', trackId: 'S-01', domain: 'surface', position: { x: 0, y: 6.7 }, courseDeg: 180, speedKts: 4 });
    const stale = track({ id: 'stale', trackId: 'S-02', domain: 'surface', position: { x: 0.5, y: 6.7 }, speedKts: 4, lastSeen: -20 });
    const { world, doctrine } = harness([boat, stale], []);
    doctrine.update();
    boat.position = { x: 0, y: 6.5 };
    boat.speedKts = 40;
    world.time = 1;
    doctrine.update();
    expect(world.events.filter((event) => event.type === 'doctrine_match')).toHaveLength(0);
  });

  it('does not evaluate or submit after the scenario ends', () => {
    const { world, completed } = harness([track()]);
    const submit = () => { throw new Error('should not submit'); };
    const manager = { hasTarget: (id: string) => completed.has(id), submit } as unknown as ProposalManager;
    const doctrine = new Doctrine(world, manager, { getHostileActs: () => [hostile], isEnded: () => true });
    world.time = 20;
    doctrine.update();
    expect(world.events).toHaveLength(0);
  });


  it('uses relative closing speed when own-ship motion makes a slower vessel close rapidly', () => {
    const boat = track({ id: 'boat', trackId: 'S-01', domain: 'surface', position: { x: 0, y: 6.7 }, courseDeg: 180, speedKts: 4 });
    const neighbor = track({ id: 'neighbor', trackId: 'S-02', domain: 'surface', position: { x: 0.5, y: 6.7 }, speedKts: 4 });
    const { world, doctrine, proposals } = harness([boat, neighbor], []);
    world.ownShip.speedKts = 25;
    world.ownShip.courseDeg = 0;
    doctrine.update();
    boat.speedKts = 10;
    boat.position = { x: 0, y: 6.5 };
    world.time = 1;
    doctrine.update();
    world.time = 16;
    doctrine.update();
    expect(proposals).toMatchObject([{ command: { action: 'engage_gun', target: 'boat' } }]);
  });


  it('does not use a hostile act before its recorded observation time', () => {
    const futureAct = { ...hostile, t: 100 };
    const { world, doctrine, proposals } = harness([track()], [futureAct]);
    doctrine.update();
    world.time = 99;
    doctrine.update();
    expect(world.events.filter((event) => event.type === 'doctrine_match')).toHaveLength(0);
    expect(proposals).toHaveLength(0);
    world.time = 100;
    doctrine.update();
    expect(world.events.filter((event) => event.type === 'doctrine_match')).toHaveLength(1);
    world.time = 114;
    doctrine.update();
    expect(proposals).toHaveLength(0);
    world.time = 115;
    doctrine.update();
    expect(proposals).toHaveLength(1);
  });

});
