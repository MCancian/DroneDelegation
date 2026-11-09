import { describe, expect, it, beforeAll, vi } from 'vitest';
import {
  STRAIT_TRANSIT,
  STRAIT_IDS,
  STRAIT_TRIGGERS,
  FISHING_FLEET_CENTER,
  OWN_SHIP_COURSE_DEG,
  OWN_SHIP_SPEED_KTS,
  FLEET_ABEAM_T_S,
} from '../src/sim/scenario/strait';
import { validateScenario, runScenario } from '../src/sim/scenario/scenario';
import {
  computeTimeline,
  formatGameTime,
  formatTimeline,
  SAM_MAX_RANGE_NM,
  type ScenarioTimeline,
} from '../src/sim/scenario/timeline';
import { angleDiff, bearingTo, move, rangeTo } from '../src/sim/geo';

const SEEDS = [1, 7, 42, 2024, 99999];
const timelines = new Map<number, ScenarioTimeline>();

beforeAll(() => {
  for (const seed of SEEDS) {
    timelines.set(seed, computeTimeline(STRAIT_TRANSIT, seed));
  }
}, 120_000);

// ── Data validation ──────────────────────────────────────────────────

describe('STRAIT_TRANSIT data', () => {
  it('validates with no errors', () => {
    expect(validateScenario(STRAIT_TRANSIT)).toEqual([]);
  });

  it('has unique trackIds', () => {
    const trackIds = STRAIT_TRANSIT.contacts.map((c) => c.trackId);
    expect(new Set(trackIds).size).toBe(trackIds.length);
  });

  it('A-01, S-07, A-09 belong to a1, s7, a9', () => {
    const a1 = STRAIT_TRANSIT.contacts.find((c) => c.id === STRAIT_IDS.a1);
    const s7 = STRAIT_TRANSIT.contacts.find((c) => c.id === STRAIT_IDS.s7);
    const a9 = STRAIT_TRANSIT.contacts.find((c) => c.id === STRAIT_IDS.a9);
    expect(a1?.trackId).toBe('A-01');
    expect(s7?.trackId).toBe('S-07');
    expect(a9?.trackId).toBe('A-09');
  });

  it('exactly 5 contacts named Fishing dhow', () => {
    const dhows = STRAIT_TRANSIT.contacts.filter((c) => c.name === 'Fishing dhow');
    expect(dhows.length).toBe(5);
  });

  it('4 airliners besides a9 (civil air, mode3, 33000-37000 ft, 450-480 kts)', () => {
    const airliners = STRAIT_TRANSIT.contacts.filter(
      (c) =>
        c.domain === 'air' &&
        c.truth === 'civil' &&
        c.id !== STRAIT_IDS.a9 &&
        c.sensors?.iff?.kind === 'mode3' &&
        c.altitudeFt >= 33000 &&
        c.altitudeFt <= 37000 &&
        c.speedKts >= 450 &&
        c.speedKts <= 480,
    );
    expect(airliners.length).toBe(4);
  });

  it('MPA is friendly with iff mode4 and loiter centre y < -30', () => {
    const mpa = STRAIT_TRANSIT.contacts.find((c) => c.id === 'mpa');
    expect(mpa).toBeDefined();
    expect(mpa!.truth).toBe('friendly');
    expect(mpa!.classification).toBe('friendly');
    expect(mpa!.sensors?.iff).toEqual({ kind: 'mode4' });
    expect(mpa!.behavior.kind).toBe('loiter');
    if (mpa!.behavior.kind === 'loiter') {
      expect(mpa!.behavior.center.y).toBeLessThan(-30);
    }
  });

  it('>= 8 civil surface contacts', () => {
    const civilSurface = STRAIT_TRANSIT.contacts.filter(
      (c) => c.domain === 'surface' && c.truth === 'civil',
    );
    expect(civilSurface.length).toBeGreaterThanOrEqual(8);
  });

  it('tanker/container/ferry/fast-ferry have AIS vessel info', () => {
    for (const id of ['tanker', 'container', 'ferry', 'fast-ferry']) {
      const c = STRAIT_TRANSIT.contacts.find((cc) => cc.id === id);
      expect(c).toBeDefined();
      expect(c!.sensors?.ais?.kind).toBe('vessel');
    }
  });

  it('fishing fleet at bearing 70 / 6.5 nm at T+8:00', () => {
    const ownAt480 = move({ x: 0, y: 0 }, OWN_SHIP_COURSE_DEG, OWN_SHIP_SPEED_KTS, FLEET_ABEAM_T_S);
    const brg = bearingTo(ownAt480, FISHING_FLEET_CENTER);
    const rng = rangeTo(ownAt480, FISHING_FLEET_CENTER);
    expect(Math.abs(brg - 70)).toBeLessThan(0.5);
    expect(Math.abs(rng - 6.5)).toBeLessThan(0.05);
  });

  it('fishing fleet mean position at T+8:00 near FISHING_FLEET_CENTER', () => {
    let meanPos = { x: 0, y: 0 };
    runScenario(STRAIT_TRANSIT, 1, {
      untilS: 480,
      onStep: (world) => {
        if (Math.abs(world.time - 480) < 0.05) {
          const ids = ['dhow-1', 'dhow-2', 'dhow-3', 'dhow-4', 'dhow-5', 's7'];
          let sx = 0;
          let sy = 0;
          let n = 0;
          for (const id of ids) {
            const c = world.contactById(id);
            if (c) {
              sx += c.position.x;
              sy += c.position.y;
              n++;
            }
          }
          if (n > 0) meanPos = { x: sx / n, y: sy / n };
        }
      },
    });
    expect(rangeTo(meanPos, FISHING_FLEET_CENTER)).toBeLessThan(1.5);
  });

  it('fast ferry E4 passes own ship', () => {
    let minRange = Infinity;
    let endRange = 0;
    let speed = 0;
    let destroyed = false;
    runScenario(STRAIT_TRANSIT, 1, {
      onStep: (world) => {
        const ff = world.contactById(STRAIT_IDS.fastFerry);
        if (ff) {
          if (!ff.alive) destroyed = true;
          const r = rangeTo(world.ownShip.position, ff.position);
          if (r < minRange) minRange = r;
          speed = ff.speedKts;
          endRange = r;
        }
      },
    });
    expect(minRange).toBeGreaterThanOrEqual(3.6);
    expect(minRange).toBeLessThanOrEqual(4.6);
    expect(speed).toBe(25);
    expect(destroyed).toBe(false);
    expect(endRange).toBeGreaterThan(minRange);
  });
});

// ── Per-seed constraint tests ────────────────────────────────────────

for (const seed of SEEDS) {
  describe(`seed ${seed}`, () => {
    const tl = () => timelines.get(seed)!;

    it('constraint 1: S-7 launches before visual ID', () => {
      const t = tl();
      expect(t.s7.launch).not.toBeNull();
      expect(t.s7.launch!.rangeNm).toBeGreaterThan(t.s7.visualRangeNm);
      expect(t.s7.launch!.rangeNm).toBeGreaterThanOrEqual(4.8);
      expect(t.s7.launch!.rangeNm).toBeLessThan(5.0);
      expect(t.s7.minRangeBeforeLaunchNm).toBeGreaterThan(t.s7.visualRangeNm);
      expect(t.s7.sprint).not.toBeNull();
      expect(Math.abs(t.s7.sprint!.t - 480)).toBeLessThan(0.15);
      expect(t.s7.launch!.t).toBeGreaterThanOrEqual(560);
      expect(t.s7.launch!.t).toBeLessThanOrEqual(700);
    });

    it('constraint 2: A-9 enters SAM range before civil confirmation', () => {
      const t = tl();
      expect(t.a9.enterSamRange).not.toBeNull();
      expect(t.a9.esmReport).not.toBeNull();
      expect(t.a9.radioId).not.toBeNull();
      expect(t.a9.turn).not.toBeNull();

      expect(t.a9.enterSamRange!.t).toBeLessThan(t.a9.esmReport!.t);
      expect(t.a9.esmReport!.rangeNm).toBeGreaterThanOrEqual(31.5);
      expect(t.a9.esmReport!.rangeNm).toBeLessThan(32.0);
      expect(t.a9.enterSamRange!.rangeNm).toBeGreaterThanOrEqual(39.5);
      expect(t.a9.enterSamRange!.rangeNm).toBeLessThan(40.0);
      expect(t.a9.enterSamRange!.t).toBeGreaterThanOrEqual(690);
      expect(t.a9.enterSamRange!.t).toBeLessThanOrEqual(730);
      expect(t.a9.esmReport!.t).toBeGreaterThanOrEqual(760);
      expect(t.a9.esmReport!.t).toBeLessThanOrEqual(795);
      expect(t.a9.radioId!.rangeNm).toBeGreaterThanOrEqual(27.5);
      expect(t.a9.radioId!.rangeNm).toBeLessThan(28.0);
      expect(t.a9.radioId!.t).toBeGreaterThan(t.a9.esmReport!.t);
      expect(Math.abs(t.a9.turn!.t - 840)).toBeLessThan(0.15);
      expect(t.a9.turn!.rangeNm).toBeGreaterThanOrEqual(22);
      expect(t.a9.turn!.rangeNm).toBeLessThanOrEqual(26);
    });

    it('constraint 3: A-1 and A-9 profiles match', () => {
      const t = tl();
      expect(t.a1.detected).not.toBeNull();
      expect(t.a9.detected).not.toBeNull();
      expect(Math.abs(t.a1.detected!.altitudeFt - t.a9.detected!.altitudeFt)).toBeLessThanOrEqual(1000);
      expect(Math.abs(t.a1.detected!.speedKts - t.a9.detected!.speedKts)).toBeLessThanOrEqual(30);
      expect(Math.abs(angleDiff(t.a1.detected!.bearingDeg, t.a9.detected!.bearingDeg))).toBeLessThanOrEqual(15);
      expect(t.a1.detected!.rangeNm).toBeGreaterThanOrEqual(58);
      expect(t.a1.detected!.rangeNm).toBeLessThanOrEqual(61);
      expect(t.a9.detected!.rangeNm).toBeGreaterThanOrEqual(58);
      expect(t.a9.detected!.rangeNm).toBeLessThanOrEqual(61);
    });

    it('constraint 4: no player action — missiles launched, A-9 survives', () => {
      const t = tl();
      expect(t.a1.launch).not.toBeNull();
      expect(t.a1.launch!.rangeNm).toBeGreaterThanOrEqual(29.5);
      expect(t.a1.launch!.rangeNm).toBeLessThan(30.0);
      expect(t.a1.launch!.t).toBeGreaterThanOrEqual(280);
      expect(t.a1.launch!.t).toBeLessThanOrEqual(320);
      expect(t.s7.launch).not.toBeNull();
      expect(t.missileLaunches.length).toBe(2);
      const launchers = t.missileLaunches.map((m) => m.launcherId).sort();
      expect(launchers).toEqual(['a1', 's7']);
      for (const m of t.missileLaunches) {
        expect(m.count).toBe(2);
      }
      expect(t.a9.aliveAtEnd).toBe(true);
      expect(t.a1.turnAway).not.toBeNull();
      expect(t.a1.turnAway!.t).toBe(t.a1.launch!.t);
    });
  });
}

// ── Custom hooks ─────────────────────────────────────────────────────

describe('custom hooks', () => {
  it('calls launchMissiles exactly twice', () => {
    const mock = vi.fn();
    computeTimeline(STRAIT_TRANSIT, 1, { launchMissiles: mock });
    expect(mock).toHaveBeenCalledTimes(2);
  });
});

// ── formatGameTime ───────────────────────────────────────────────────

describe('formatGameTime', () => {
  it('formats correctly', () => {
    expect(formatGameTime(298.4)).toBe('T+4:58');
    expect(formatGameTime(45)).toBe('T+0:45');
    expect(formatGameTime(840)).toBe('T+14:00');
  });
});

// ── formatTimeline ───────────────────────────────────────────────────

describe('formatTimeline', () => {
  it('contains expected strings', () => {
    const tl = computeTimeline(STRAIT_TRANSIT, 1);
    const output = formatTimeline(tl);
    expect(output).toContain('A-1');
    expect(output).toContain('S-7');
    expect(output).toContain('A-9');
    expect(output).toContain('alive at end: yes');
  });
});
