import { describe, expect, it } from 'vitest';
import { fromBearingRange } from '../src/sim/geo';
import {
  cappedLeaderLengthPx,
  DEFAULT_RANGE_NM,
  LEADER_MAX_SCOPE_FRACTION,
  LEADER_MINUTES,
  RANGE_SCALES,
  RING_LABEL_CANDIDATE_BEARINGS,
  bearingToScreenAngle,
  clampRange,
  isInsideScope,
  leaderLengthPx,
  makeProjection,
  nextRangeStep,
  pickRingLabelBearing,
  pointAtBearing,
  pxPerNm,
  rectsOverlap,
  ringLabelRect,
  ringRadiiNm,
  screenToWorld,
  worldToScreen,
} from '../src/ui/radarProjection';
import type { ScreenRect } from '../src/ui/radarProjection';

describe('radarProjection', () => {
  it('exposes the required range scales', () => {
    expect(RANGE_SCALES).toEqual([10, 20, 40, 80]);
    expect(DEFAULT_RANGE_NM).toBe(40);
  });

  it('maps the own-ship origin to the scope center', () => {
    const p = makeProjection(800, 600, 40, { x: 0, y: 0 }, 20);
    expect(p.centerPx).toEqual({ x: 400, y: 300 });
    expect(p.radiusPx).toBe(280);
    expect(pxPerNm(p)).toBe(7);
    expect(worldToScreen(p, p.origin)).toEqual(p.centerPx);

    const origin = { x: 12.5, y: -7.25 };
    const p2 = makeProjection(500, 500, 20, origin);
    expect(worldToScreen(p2, origin)).toEqual(p2.centerPx);
  });

  it('clamps the scope radius to at least one pixel', () => {
    const tiny = makeProjection(10, 10, 40, { x: 0, y: 0 }, 10);
    expect(tiny.radiusPx).toBe(1);
  });

  it('places ring edges at the scope radius in cardinal directions', () => {
    const origin = { x: 3, y: -2 };
    const p = makeProjection(800, 600, 40, origin, 20);

    const cases = [
      {
        bearing: 0,
        x: p.centerPx.x,
        y: p.centerPx.y - p.radiusPx,
      },
      {
        bearing: 90,
        x: p.centerPx.x + p.radiusPx,
        y: p.centerPx.y,
      },
      {
        bearing: 180,
        x: p.centerPx.x,
        y: p.centerPx.y + p.radiusPx,
      },
      {
        bearing: 270,
        x: p.centerPx.x - p.radiusPx,
        y: p.centerPx.y,
      },
    ];

    for (const testCase of cases) {
      const world = fromBearingRange(origin, testCase.bearing, p.rangeNm);
      const screen = worldToScreen(p, world);

      expect(screen.x).toBeCloseTo(testCase.x, 10);
      expect(screen.y).toBeCloseTo(testCase.y, 10);
      expect(
        Math.hypot(screen.x - p.centerPx.x, screen.y - p.centerPx.y),
      ).toBeCloseTo(p.radiusPx, 10);
    }
  });

  it('uses the north-up bearing convention', () => {
    const p = makeProjection(400, 400, 40, { x: 0, y: 0 });
    const scale = pxPerNm(p);
    const rNm = 10;
    const rPx = rNm * scale;

    const cases = [
      {
        bearing: 0,
        angle: -Math.PI / 2,
        x: p.centerPx.x,
        y: p.centerPx.y - rPx,
      },
      {
        bearing: 90,
        angle: 0,
        x: p.centerPx.x + rPx,
        y: p.centerPx.y,
      },
      {
        bearing: 180,
        angle: Math.PI / 2,
        x: p.centerPx.x,
        y: p.centerPx.y + rPx,
      },
      {
        bearing: 270,
        angle: Math.PI,
        x: p.centerPx.x - rPx,
        y: p.centerPx.y,
      },
    ];

    for (const testCase of cases) {
      expect(bearingToScreenAngle(testCase.bearing)).toBeCloseTo(
        testCase.angle,
        10,
      );

      const world = fromBearingRange(p.origin, testCase.bearing, rNm);
      const screen = worldToScreen(p, world);
      expect(screen.x).toBeCloseTo(testCase.x, 10);
      expect(screen.y).toBeCloseTo(testCase.y, 10);

      const point = pointAtBearing(p, testCase.bearing, rPx);
      expect(point.x).toBeCloseTo(screen.x, 10);
      expect(point.y).toBeCloseTo(screen.y, 10);
    }
  });

  it('round-trips screen and world coordinates at every range scale', () => {
    for (const rangeNm of RANGE_SCALES) {
      const p = makeProjection(640, 480, rangeNm, { x: 3, y: -2 }, 10);

      const samples = [
        p.centerPx,
        { x: 0, y: 0 },
        { x: 640, y: 480 },
        { x: 123.45, y: 67.89 },
      ];

      for (const sample of samples) {
        const world = screenToWorld(p, sample.x, sample.y);
        const back = worldToScreen(p, world);

        expect(back.x).toBeCloseTo(sample.x, 10);
        expect(back.y).toBeCloseTo(sample.y, 10);
      }
    }
  });

  it('computes ring radii', () => {
    expect(ringRadiiNm(40)).toEqual([10, 20, 30, 40]);
    expect(ringRadiiNm(10)).toEqual([2.5, 5, 7.5, 10]);
    expect(ringRadiiNm(80, 3)).toEqual([
      expect.closeTo(80 / 3, 10),
      expect.closeTo(160 / 3, 10),
      expect.closeTo(80, 10),
    ]);
    expect(ringRadiiNm(40, 0)).toEqual([]);
  });

  it('steps and clamps range scales', () => {
    expect(nextRangeStep(10, -1)).toBe(10);
    expect(nextRangeStep(20, -1)).toBe(10);
    expect(nextRangeStep(40, -1)).toBe(20);
    expect(nextRangeStep(80, -1)).toBe(40);

    expect(nextRangeStep(10, 1)).toBe(20);
    expect(nextRangeStep(20, 1)).toBe(40);
    expect(nextRangeStep(40, 1)).toBe(80);
    expect(nextRangeStep(80, 1)).toBe(80);

    expect(clampRange(0)).toBe(10);
    expect(clampRange(5)).toBe(10);
    expect(clampRange(25)).toBe(20);
    expect(clampRange(35)).toBe(40);
    expect(clampRange(100)).toBe(80);

    expect(nextRangeStep(35, 1)).toBe(40);
    expect(nextRangeStep(35, -1)).toBe(20);
    expect(nextRangeStep(5, 1)).toBe(10);
    expect(nextRangeStep(5, -1)).toBe(10);
    expect(nextRangeStep(100, -1)).toBe(80);
    expect(nextRangeStep(100, 1)).toBe(80);
  });

  it('scales leader length with speed, time, and range scale', () => {
    const p40 = makeProjection(400, 400, 40, { x: 0, y: 0 });
    const p80 = makeProjection(400, 400, 80, { x: 0, y: 0 });

    const base = leaderLengthPx(10, p40);
    expect(base).toBeCloseTo((10 / 60) * pxPerNm(p40), 10);
    expect(leaderLengthPx(20, p40)).toBeCloseTo(base * 2, 10);
    expect(leaderLengthPx(10, p40, 2)).toBeCloseTo(base * 2, 10);
    expect(leaderLengthPx(10, p80)).toBeCloseTo(base / 2, 10);
    expect(leaderLengthPx(0, p40)).toBe(0);
    expect(leaderLengthPx(-5, p40)).toBe(0);
  });

  it('detects whether a world position is inside the scope', () => {
    const origin = { x: -4, y: 9 };
    const p = makeProjection(600, 600, 20, origin);

    expect(isInsideScope(p, origin)).toBe(true);
    expect(isInsideScope(p, fromBearingRange(origin, 0, p.rangeNm))).toBe(true);
    expect(
      isInsideScope(p, fromBearingRange(origin, 0, p.rangeNm + 0.1)),
    ).toBe(false);
    expect(
      isInsideScope(p, fromBearingRange(origin, 90, p.rangeNm - 0.1)),
    ).toBe(true);
  });

  describe('cappedLeaderLengthPx', () => {
    const p = makeProjection(400, 400, 40, { x: 0, y: 0 }, 0);
    const p10 = makeProjection(400, 400, 10, { x: 0, y: 0 }, 0);

    it('caps a 600 kt leader at 15% of scope radius', () => {
      const result = cappedLeaderLengthPx(600, p);
      expect(result).toBeCloseTo(30, 10);
      expect(result).toBeLessThanOrEqual(0.15 * p.radiusPx);
    });

    it('does not cap a 120 kt leader on the 40 nm scope', () => {
      expect(cappedLeaderLengthPx(120, p)).toBeCloseTo(10, 10);
    });

    it('does not cap a 15 kt leader', () => {
      expect(cappedLeaderLengthPx(15, p)).toBeCloseTo(1.25, 10);
    });

    it('caps a 120 kt leader on the 10 nm scope', () => {
      expect(cappedLeaderLengthPx(120, p10)).toBeCloseTo(30, 10);
    });

    it('returns 0 for zero or negative speed', () => {
      expect(cappedLeaderLengthPx(0, p)).toBe(0);
      expect(cappedLeaderLengthPx(-5, p)).toBe(0);
    });

    it('honours custom maxFraction', () => {
      expect(cappedLeaderLengthPx(600, p, 1, 0.5)).toBeCloseTo(50, 10);
    });

    it('a 600 kt leader from 15 nm out does not reach own ship', () => {
      const leader = cappedLeaderLengthPx(600, p);
      const distancePx = 15 * pxPerNm(p);
      expect(distancePx).toBeGreaterThan(leader);
    });
  });

  describe('rectsOverlap', () => {
    it('detects interior intersection', () => {
      expect(
        rectsOverlap(
          { x: 0, y: 0, width: 10, height: 10 },
          { x: 5, y: 5, width: 10, height: 10 },
        ),
      ).toBe(true);
    });

    it('returns false for edge-touching rects', () => {
      expect(
        rectsOverlap(
          { x: 0, y: 0, width: 10, height: 10 },
          { x: 10, y: 0, width: 10, height: 10 },
        ),
      ).toBe(false);
    });

    it('returns false for disjoint rects', () => {
      expect(
        rectsOverlap(
          { x: 0, y: 0, width: 10, height: 10 },
          { x: 20, y: 20, width: 5, height: 5 },
        ),
      ).toBe(false);
    });

    it('detects containment', () => {
      expect(
        rectsOverlap(
          { x: 0, y: 0, width: 10, height: 10 },
          { x: 2, y: 2, width: 2, height: 2 },
        ),
      ).toBe(true);
    });
  });

  describe('ringLabelRect', () => {
    const p = makeProjection(400, 400, 40, { x: 0, y: 0 }, 0);

    it('centres the rect on the bearing point (north)', () => {
      expect(ringLabelRect(p, 0, 100, 20, 10)).toEqual({
        x: 190,
        y: 95,
        width: 20,
        height: 10,
      });
    });

    it('centres the rect on the bearing point (east)', () => {
      const rect = ringLabelRect(p, 90, 100, 20, 10);
      expect(rect.x).toBeCloseTo(290, 10);
      expect(rect.y).toBeCloseTo(195, 10);
    });
  });

  describe('pickRingLabelBearing', () => {
    const p = makeProjection(400, 400, 40, { x: 0, y: 0 }, 0);

    it('returns the first candidate when there are no obstacles', () => {
      expect(pickRingLabelBearing(p, 100, 20, 10, [])).toBe(45);
    });

    it('skips a blocked first candidate', () => {
      const obstacle = ringLabelRect(p, 45, 100, 20, 10);
      expect(pickRingLabelBearing(p, 100, 20, 10, [obstacle])).toBe(135);
    });

    it('returns the only unblocked candidate', () => {
      const obstacles: ScreenRect[] = [45, 135, 225, 315, 90, 0, 180].map(
        (b) => ringLabelRect(p, b, 100, 20, 10),
      );
      expect(pickRingLabelBearing(p, 100, 20, 10, obstacles)).toBe(270);
    });

    it('returns the candidate with fewest overlaps when all are blocked', () => {
      const obstacles: ScreenRect[] = [
        ringLabelRect(p, 45, 100, 20, 10),
        ringLabelRect(p, 45, 100, 20, 10),
        ringLabelRect(p, 135, 100, 20, 10),
        ringLabelRect(p, 225, 100, 20, 10),
        ringLabelRect(p, 315, 100, 20, 10),
        ringLabelRect(p, 90, 100, 20, 10),
        ringLabelRect(p, 270, 100, 20, 10),
        ringLabelRect(p, 0, 100, 20, 10),
        ringLabelRect(p, 180, 100, 20, 10),
      ];
      expect(pickRingLabelBearing(p, 100, 20, 10, obstacles)).toBe(135);
    });

    it('honours custom candidates', () => {
      const obstacle = ringLabelRect(p, 10, 100, 20, 10);
      expect(pickRingLabelBearing(p, 100, 20, 10, [obstacle], [10, 100])).toBe(100);
    });

    it('returns 45 for an empty candidate list', () => {
      expect(pickRingLabelBearing(p, 100, 20, 10, [], [])).toBe(45);
    });
  });
});
