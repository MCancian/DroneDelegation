import { describe, it, expect } from 'vitest';
import { serializeSituation, SituationHistory } from '../src/ai/situation';
import { STRAIT_TRANSIT } from '../src/sim/scenario/strait';
import { stepScenario } from './helpers/sim';
import { STEP_S } from '../src/sim/clock';
import { loadScenario as load } from '../src/sim/scenario/scenario';
import { bearingTo } from '../src/sim/geo';

function loadStrait(seed: number) {
  return load(STRAIT_TRANSIT, seed);
}

describe('serializeSituation', () => {
  it('never leaks truth-only fields across 3 seeds', () => {
    for (const seed of [1, 42, 99]) {
      const { world, runner } = loadStrait(seed);
      const history = new SituationHistory();
      history.observe(world);
      for (let t = 0; t <= 900; t += 10) {
        const out = serializeSituation(world, history.acts());
        expect(out).not.toContain('"truth"');
        expect(out).not.toContain('personsAboard');
        expect(out).not.toContain('"rcs"');
        expect(out).not.toContain('"pDetect"');
        if (t < 900) {
          stepScenario(runner, 10);
          history.observe(world);
        }
      }
    }
  });

  it('A-9 at ~50nm contains no civil/212/truth', () => {
    const { world, runner } = loadStrait(7);
    const history = new SituationHistory();
    history.observe(world);
    let found = false;
    for (let t = 0; t <= 900; t += 10) {
      const tracks = world.visibleTracks();
      const a9 = tracks.find((tr) => tr.trackId === 'A-09');
      if (a9) {
        const rng = Math.hypot(a9.position.x, a9.position.y);
        if (rng > 45 && rng < 55) {
          const out = serializeSituation(world, history.acts());
          expect(out).not.toContain('212');
          expect(out).not.toContain('civil');
          expect(out).not.toContain('"truth"');
          found = true;
        }
      }
      if (t < 900) { stepScenario(runner, 10); history.observe(world); }
    }
    expect(found).toBe(true);
  });

  it('background AIS civil info is legitimate', () => {
    const { world } = loadStrait(1);
    const out = serializeSituation(world);
    expect(out).toContain('GULF PEARL');
  });

  it('serialized output is stable for same world state', () => {
    const { world } = loadStrait(5);
    const a = serializeSituation(world);
    const b = serializeSituation(world);
    expect(a).toBe(b);
  });

  it('poison hidden fields do not appear in output', () => {
    const { world } = loadStrait(1);
    const contact = world.contacts[0];
    (contact as any).personsAboard = 999;
    (contact as any).truth = 'secret';
    (contact as any).nested = { secret: 'leak' };
    const out = serializeSituation(world);
    expect(out).not.toContain('999');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('leak');
  });
});

describe('SituationHistory', () => {
  it('records A-1 launch profile observed before turn-away', () => {
    const { world, runner } = loadStrait(1);
    const history = new SituationHistory();
    history.observe(world);
    let observedLaunchBearing: number | undefined;
    let launchTime: number | undefined;
    for (let i = 0; i < 9000; i++) {
      const observed = world.visibleTracks().find(t => t.trackId === 'A-01');
      const observedBearing = observed && bearingTo(world.ownShip.position, observed.position);
      world.step(STEP_S);
      runner.update();
      const launch = world.events.find(e => e.type === 'ascm_launched');
      if (launchTime === undefined && launch) {
        launchTime = launch.t;
        observedLaunchBearing = observedBearing;
      }
      history.observe(world);
      if (history.acts().length > 0) break;
    }
    const acts = history.acts();
    expect(acts.length).toBeGreaterThanOrEqual(1);
    const a1act = acts.find((a) => a.trackId === 'A-01');
    expect(a1act).toBeDefined();
    expect(a1act!.speedKts).toBeCloseTo(420, 0);
    expect(a1act!.altitudeFt).toBeCloseTo(15000, 0);
    expect(observedLaunchBearing).toBeDefined();
    expect(a1act!.bearingDeg).toBeCloseTo(observedLaunchBearing!, 6);
    expect(a1act!.t).toBeCloseTo(launchTime!, 6);
    expect(acts.filter(a => a.trackId === 'A-01')).toHaveLength(1);
  });

  it('does not record undetected missiles', () => {
    const { world, runner } = loadStrait(1);
    const history = new SituationHistory();
    history.observe(world);
    for (let i = 0; i < 100; i++) {
      world.step(STEP_S);
      runner.update();
      history.observe(world);
    }
    const tracks = world.visibleTracks();
    const missiles = tracks.filter((t) => t.domain === 'missile' && !t.ownMissile);
    if (missiles.length === 0) {
      expect(history.acts()).toHaveLength(0);
    }
  });

  it('pending launch does not leak before missile detection', () => {
    const { world, runner } = loadStrait(1);
    const history = new SituationHistory();
    history.observe(world);
    let launchEventSeen = false;
    for (let i = 0; i < 9000; i++) {
      world.step(STEP_S);
      runner.update();
      history.observe(world);
      const hasLaunch = world.events.some((e) => e.type === 'ascm_launched');
      if (hasLaunch && !launchEventSeen) {
        launchEventSeen = true;
        const tracks = world.visibleTracks();
        const missiles = tracks.filter((t) => t.domain === 'missile' && !t.ownMissile);
        if (missiles.length === 0) {
          expect(history.acts()).toHaveLength(0);
        }
      }
      if (history.acts().length > 0) break;
    }
    expect(history.acts().length).toBeGreaterThanOrEqual(1);
  });

  it('retains confirmed history after attacker disappears', () => {
    const { world, runner } = loadStrait(1);
    const history = new SituationHistory();
    history.observe(world);
    for (let i = 0; i < 9000; i++) {
      world.step(STEP_S);
      runner.update();
      history.observe(world);
    }
    const acts = history.acts();
    expect(acts.length).toBeGreaterThanOrEqual(1);
    expect(acts.some((a) => a.trackId === 'A-01')).toBe(true);
  });

  it('captured bearing/range stable after ownship maneuvers', () => {
    const { world, runner } = loadStrait(1);
    const history = new SituationHistory();
    history.observe(world);
    for (let i = 0; i < 9000; i++) {
      world.step(STEP_S);
      runner.update();
      history.observe(world);
      if (history.acts().length > 0) break;
    }
    const acts = history.acts();
    expect(acts.length).toBeGreaterThanOrEqual(1);
    const first = acts[0];
    // Continue stepping - ownship moves, but history should not change
    for (let i = 0; i < 2000; i++) {
      world.step(STEP_S);
      runner.update();
      history.observe(world);
    }
    const actsAfter = history.acts();
    const same = actsAfter.find((a) => a.trackId === first.trackId && a.t === first.t);
    expect(same).toBeDefined();
    expect(same!.bearingDeg).toBeCloseTo(first.bearingDeg, 0);
    expect(same!.rangeNm).toBeCloseTo(first.rangeNm, 0);
  });
});
