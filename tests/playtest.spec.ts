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
    expect(first.weapons.config.gun.pkPerBurst).toBe(0.9);
    expect(first.weapons.config.ciws.pkPerMissile).toBe(0.85);
    first.weapons.config.gun.pkPerBurst = 0;
    first.weapons.config.sam.pkSalvoVsAircraft = 0;
    expect(second.weapons.config.gun.pkPerBurst).toBe(0.9);
    expect(STRAIT_TRANSIT.weaponsConfig!.gun.pkPerBurst).toBe(0.9);
    expect(WEAPONS_CONFIG.gun.pkPerBurst).toBe(0.35);
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

    // Doctrine makes a timely attempt, but gun and SAM hit probabilities do
    // not guarantee a kill. Runs ended early cannot promise a later outcome.
    expect(free.every(r => r.s7EngagedAtS !== null && (r.s7LaunchedAtS === null || r.s7EngagedAtS < r.s7LaunchedAtS))).toBe(true);
    expect(free.filter(r => r.s7Stopped && r.s7LaunchedAtS === null).length).toBeGreaterThan(10);
    expect(free.filter(r => r.a9ShotDown).length).toBeGreaterThan(10);
    expect(free.every(r => r.a9EngagedAtS !== null || r.shipLost)).toBe(true);
    expect(free.filter(r => (r.a1Stopped && r.a1LaunchedAtS === null) || (r.a1MissilesLaunched > 0 && r.a1MissilesDefeated === r.a1MissilesLaunched)).length).toBeGreaterThan(10);

    expect(careful.every(r => r.a1EngagedAtS !== null && !r.a9ShotDown && r.a9EngagedAtS === null)).toBe(true);
    expect(careful.filter(r => r.a1Stopped && r.a1LaunchedAtS === null).length).toBeGreaterThan(10);
    expect(careful.filter(r => r.hullPct < 100).length).toBeLessThan(hold.filter(r => r.hullPct < 100).length);
    expect(careful.filter(r => r.hullPct < 100).length).toBeLessThanOrEqual(free.filter(r => r.hullPct < 100).length);
    expect(slow.every(r => r.s7LaunchedAtS !== null && (r.s7VisualAtS === null || r.s7LaunchedAtS < r.s7VisualAtS))).toBe(true);
    expect(slow.every(r => r.s7EngagedAtS === null || (r.s7VisualAtS !== null && r.s7EngagedAtS >= r.s7VisualAtS))).toBe(true);
  }, 120_000);
});
