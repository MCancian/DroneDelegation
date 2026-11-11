import { describe, expect, it } from 'vitest';
import { runPlaytests, summarizePlaytests } from '../src/sim/playtest';
import { loadScenario } from '../src/sim/scenario/scenario';
import { STRAIT_TRANSIT } from '../src/sim/scenario/strait';
import { WEAPONS_CONFIG } from '../src/sim/scenario/weaponsConfig';

// 20 deterministic but independently seeded, fully simulated runs per policy.
// Ship loss ends a run; do not silently extend it to obtain later outcomes.
describe('Strait Transit strategy playtests', () => {
  it('isolates scenario weapon settings between worlds and the global defaults', () => {
    const first = loadScenario(STRAIT_TRANSIT, 1).world;
    const second = loadScenario(STRAIT_TRANSIT, 2).world;
    expect(first.sensorConfig.maxRangeNm.missile).toBe(1);
    expect(first.weapons.config.ciws.pkPerMissile).toBe(0.85);
    first.sensorConfig.maxRangeNm.missile = 2;
    first.weapons.config.sam.pkSalvoVsAircraft = 0;
    expect(second.weapons.config.ascm.damagePct).toBe(20);
    expect(second.sensorConfig.maxRangeNm.missile).toBe(1);
    expect(STRAIT_TRANSIT.sensorConfig!.maxRangeNm.missile).toBe(1);
    expect(STRAIT_TRANSIT.weaponsConfig!.ascm.damagePct).toBe(20);
    expect(WEAPONS_CONFIG.ascm.damagePct).toBe(40);
    expect(WEAPONS_CONFIG.sam.pkSalvoVsAircraft).toBe(0.85);
  });
  it('retains the intended authority and information trade-offs across seeds', () => {
    const results = runPlaytests();
    const summary = summarizePlaytests(results);
    console.table(summary);
    const hold = results.filter(r => r.strategy === 'hold');
    const free = results.filter(r => r.strategy === 'free');
    const careful = results.filter(r => r.strategy === 'careful');
    const slow = results.filter(r => r.strategy === 'slow');
    expect(hold).toHaveLength(20);
    expect(hold.every(r => !r.a9ShotDown && r.a9EngagedAtS === null)).toBe(true);
    expect(hold.filter(r => r.hullPct < 100).length).toBeGreaterThan(0);
    expect(hold.every(r => r.s7LaunchedAtS !== null)).toBe(true);

    // Gun engagements complete with a guaranteed kill after their timed burst.
    // SAM probability remains meaningful and runs ended early cannot promise later outcomes.
    expect(free.every(r => r.s7EngagedAtS !== null && (r.s7LaunchedAtS === null || r.s7EngagedAtS < r.s7LaunchedAtS))).toBe(true);
    expect(free.filter(r => r.s7Stopped && r.s7LaunchedAtS === null).length).toBeGreaterThan(10);
    expect(free.filter(r => r.a9ShotDown).length).toBeGreaterThan(10);
    expect(free.every(r => r.a9EngagedAtS !== null || r.shipLost)).toBe(true);
    // WEAPONS FREE applies only to air/surface engagements; it cannot silently
    // bypass the explicitly-MANUAL point-defense control.
    expect(free.every(r => r.a1MissilesIntercepted === 0)).toBe(true);

    expect(careful.every(r => r.a1EngagedAtS !== null && !r.a9ShotDown && r.a9EngagedAtS === null)).toBe(true);
    // The faster attacker can launch while the SAM is in flight. The careful
    // strategy also explicitly activates defense on the first missile warning.
    expect(careful.filter(r => r.a1Stopped).length).toBeGreaterThan(10);
    expect(careful.filter(r => r.hullPct < 100).length).toBeLessThan(hold.filter(r => r.hullPct < 100).length);
    expect(careful.filter(r => r.hullPct < 100).length).toBeLessThanOrEqual(free.filter(r => r.hullPct < 100).length);
    expect(slow.every(r => r.s7LaunchedAtS !== null && (r.s7VisualAtS === null || r.s7LaunchedAtS < r.s7VisualAtS))).toBe(true);
    expect(slow.every(r => r.s7EngagedAtS === null || (r.s7VisualAtS !== null && r.s7EngagedAtS >= r.s7VisualAtS))).toBe(true);
  }, 120_000);
});
