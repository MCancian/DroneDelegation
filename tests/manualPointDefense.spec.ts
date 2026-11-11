import { describe, expect, it } from 'vitest';
import { STEP_S } from '../src/sim/clock';
import { loadScenario } from '../src/sim/scenario/scenario';
import { STRAIT_TRANSIT } from '../src/sim/scenario/strait';
import { executeCommand } from '../src/sim/commands';
import { launchAscms, setPointDefense } from '../src/sim/weapons';

function stepFor(world: ReturnType<typeof loadScenario>['world'], seconds: number): void {
  const steps = Math.round(seconds / STEP_S);
  for (let i = 0; i < steps; i++) world.step(STEP_S);
}

function makeMissileTestWorld(seed: number) {
  const { world } = loadScenario(STRAIT_TRANSIT, seed);
  world.weapons.config.ascm.pHit = 1;
  world.weapons.config.ciws.pkPerMissile = 1;
  return world;
}

function launchTestMissile(seed: number) {
  const world = makeMissileTestWorld(seed);
  launchAscms(world, {
    count: 1, weapon: 'ASCM', speedKts: 600, altitudeFt: 50,
    launcherId: 'test-launcher', trackId: 'S-07', t: world.time,
    position: { x: 0, y: 1.5 }, rangeNm: 1.5, bearingDeg: 0,
  });
  return world;
}

describe('manual point-defense reaction window', () => {
  it('starts MANUAL and gives about 2–6 seconds after radar detection across sweep phases', () => {
    const measurements: { launchPhase: number; detectionDelay: number; detectionToImpact: number }[] = [];
    for (const [seed, launchPhase] of [[1, 0], [2, 1], [3, 2], [4, 3]] as const) {
      const world = makeMissileTestWorld(seed);
      stepFor(world, launchPhase);
      const launchedAt = world.time;
      launchAscms(world, {
        count: 1, weapon: 'ASCM', speedKts: 600, altitudeFt: 50,
        launcherId: 'test-launcher', trackId: 'S-07', t: world.time,
        position: { x: 0, y: 1.5 }, rangeNm: 1.5, bearingDeg: 0,
      });
      expect(world.weapons.pointDefense).toBe('manual');
      expect(world.sensorConfig.maxRangeNm.missile).toBe(1);
      expect(world.contactById('ascm-1')).toBeDefined();
      expect(world.trackFor('ascm-1')).toBeUndefined();

      for (let i = 0; i < 120 && world.trackFor('ascm-1')?.detected !== true; i++) world.step(STEP_S);
      expect(world.trackFor('ascm-1')?.detected).toBe(true);
      const detectedAt = world.time;
      for (let i = 0; i < 120 && !world.events.some(event => event.type === 'missile_impact' &&
        (event.payload as { missileId?: string }).missileId === 'ascm-1'); i++) world.step(STEP_S);
      const impact = world.events.find(event => event.type === 'missile_impact' &&
        (event.payload as { missileId?: string }).missileId === 'ascm-1');
      expect(impact).toBeDefined();
      measurements.push({
        launchPhase,
        detectionDelay: detectedAt - launchedAt,
        detectionToImpact: impact!.t - detectedAt,
      });
      expect(world.events.some(event => event.actor === 'crew-auto' &&
        (event.type === 'chaff_deployed' || event.type === 'weapon_fired'))).toBe(false);
    }

    expect(measurements.map(({ detectionDelay, detectionToImpact }) =>
      [Math.round(detectionDelay), Math.round(detectionToImpact)]))
      .toEqual([[4, 4], [3, 5], [6, 2], [5, 3]]);
  });

  it('makes a five-second manual reaction too late in most sampled sweep phases', () => {
    let damaged = 0;
    let intercepted = 0;
    for (const launchPhase of [0, 1, 2, 3]) {
      const world = makeMissileTestWorld(1);
      stepFor(world, launchPhase);
      launchAscms(world, {
        count: 1, weapon: 'ASCM', speedKts: 600, altitudeFt: 50,
        launcherId: 'test-launcher', trackId: 'S-07', t: world.time,
        position: { x: 0, y: 1.5 }, rangeNm: 1.5, bearingDeg: 0,
      });
      for (let i = 0; i < 120 && world.trackFor('ascm-1')?.detected !== true; i++) world.step(STEP_S);
      expect(world.trackFor('ascm-1')?.detected).toBe(true);
      stepFor(world, 5);
      expect(executeCommand(world, { action: 'set_point_defense', mode: 'auto' }, 'player').ok).toBe(true);
      stepFor(world, 1);
      if (world.ownShip.hullPct < 100) damaged++;
      if (world.events.some(event => event.type === 'contact_destroyed' &&
        (event.payload as { contactId?: string }).contactId === 'ascm-1')) intercepted++;
    }
    expect(damaged).toBe(3);
    expect(intercepted).toBe(1);
  });

  it('lets a prompt player activate AUTO and intercept before impact', () => {
    const world = launchTestMissile(1);
    stepFor(world, 4.1);
    const track = world.trackFor('ascm-1');
    expect(track?.detected).toBe(true);
    expect(world.weapons.pointDefense).toBe('manual');

    setPointDefense(world, 'auto', 'player');
    world.step(STEP_S);

    expect(world.contactById('ascm-1')?.alive).toBe(false);
    expect(world.events.some(event => event.type === 'chaff_deployed' && event.actor === 'crew-auto')).toBe(true);
    expect(world.events.some(event => event.type === 'weapon_fired' && event.actor === 'crew-auto' &&
      (event.payload as { weapon?: string }).weapon === 'ciws')).toBe(true);
    expect(world.ownShip.hullPct).toBe(100);
  });

  it('cannot activate AUTO after the missile has entered its impact radius', () => {
    const world = launchTestMissile(1);
    stepFor(world, 4.1);
    const track = world.trackFor('ascm-1');
    expect(track?.detected).toBe(true);
    // Preserve the detected track while placing the live missile inside the
    // impact radius, so this isolates the too-late defense rule.
    world.contactById('ascm-1')!.position = { x: 0, y: 0.05 };
    const ciws = executeCommand(world, { action: 'ciws', target: 'ascm-1' }, 'player');
    expect(ciws.ok).toBe(false);
    if (!ciws.ok) expect(ciws.error).toContain('too late for CIWS');

    setPointDefense(world, 'auto', 'player');
    world.step(STEP_S);

    expect(world.events.some(event => event.type === 'missile_impact' &&
      (event.payload as { missileId?: string; hit?: boolean }).missileId === 'ascm-1' &&
      (event.payload as { hit?: boolean }).hit === true)).toBe(true);
    expect(world.events.some(event => event.type === 'weapon_fired' && event.actor === 'crew-auto' &&
      (event.payload as { weapon?: string }).weapon === 'ciws')).toBe(false);
    expect(world.ownShip.hullPct).toBe(80);
  });
});
