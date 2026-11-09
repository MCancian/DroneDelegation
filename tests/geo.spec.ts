import { describe, expect, it } from 'vitest';
import {
  angleDiff,
  bearingTo,
  closingSpeed,
  cpa,
  fromBearingRange,
  knotsToNmPerSec,
  move,
  rangeTo,
  relativeMotion,
  velocityFrom,
} from '../src/sim/geo';
import type { Vec2 } from '../src/sim/types';

describe('geo', () => {
  const origin: Vec2 = { x: 0, y: 0 };

  it('bearingTo returns cardinal and quadrant bearings', () => {
    const from: Vec2 = { x: 1, y: 2 };
    const cases: Array<[number, number]> = [
      [bearingTo(origin, { x: 0, y: 10 }), 0],
      [bearingTo(origin, { x: 10, y: 0 }), 90],
      [bearingTo(origin, { x: 0, y: -10 }), 180],
      [bearingTo(origin, { x: -10, y: 0 }), 270],
      [bearingTo(origin, { x: 10, y: 10 }), 45],
      [bearingTo(origin, { x: 10, y: -10 }), 135],
      [bearingTo(origin, { x: -10, y: -10 }), 225],
      [bearingTo(origin, { x: -10, y: 10 }), 315],
      [bearingTo(from, { x: 1, y: 12 }), 0],
      [bearingTo(from, { x: 11, y: 2 }), 90],
      [bearingTo(from, { x: 1, y: -8 }), 180],
      [bearingTo(from, { x: -9, y: 2 }), 270],
      [bearingTo(from, { x: 11, y: 12 }), 45],
      [bearingTo(from, { x: 11, y: -8 }), 135],
      [bearingTo(from, { x: -9, y: -8 }), 225],
      [bearingTo(from, { x: -9, y: 12 }), 315],
    ];

    for (const [actual, expected] of cases) {
      expect(actual).toBeCloseTo(expected, 6);
      expect(actual).toBeGreaterThanOrEqual(0);
      expect(actual).toBeLessThan(360);
    }
  });

  it('bearingTo wraps just west of north', () => {
    const bearing = bearingTo(origin, { x: -0.01, y: 10 });
    expect(bearing).toBeCloseTo(359.942704, 6);
    expect(bearing).toBeGreaterThanOrEqual(0);
    expect(bearing).toBeLessThan(360);
  });

  it('rangeTo computes a 3-4-5 triangle', () => {
    expect(rangeTo(origin, { x: 3, y: 4 })).toBeCloseTo(5, 6);
  });

  it('move advances 10 nm in one hour', () => {
    const dtSec = 3600;
    const speedKts = 10;

    const north = move(origin, 0, speedKts, dtSec);
    expect(north.x).toBeCloseTo(0, 6);
    expect(north.y).toBeCloseTo(10, 6);
    expect(bearingTo(origin, north)).toBeCloseTo(0, 6);

    const east = move(origin, 90, speedKts, dtSec);
    expect(east.x).toBeCloseTo(10, 6);
    expect(east.y).toBeCloseTo(0, 6);
    expect(bearingTo(origin, east)).toBeCloseTo(90, 6);

    const south = move(origin, 180, speedKts, dtSec);
    expect(south.x).toBeCloseTo(0, 6);
    expect(south.y).toBeCloseTo(-10, 6);
    expect(bearingTo(origin, south)).toBeCloseTo(180, 6);

    const west = move(origin, 270, speedKts, dtSec);
    expect(west.x).toBeCloseTo(-10, 6);
    expect(west.y).toBeCloseTo(0, 6);
    expect(bearingTo(origin, west)).toBeCloseTo(270, 6);

    const northeast = move(origin, 45, speedKts, dtSec);
    expect(northeast.x).toBeCloseTo(7.071068, 6);
    expect(northeast.y).toBeCloseTo(7.071068, 6);
    expect(rangeTo(origin, northeast)).toBeCloseTo(10, 6);
    expect(bearingTo(origin, northeast)).toBeCloseTo(45, 6);
  });

  it('move does not mutate its input', () => {
    const pos: Vec2 = { x: 1, y: 2 };
    const moved = move(pos, 90, 10, 3600);

    expect(pos).toEqual({ x: 1, y: 2 });
    expect(moved.x).toBeCloseTo(11, 6);
    expect(moved.y).toBeCloseTo(2, 6);
  });

  it('move normalizes 360 and -90', () => {
    const north = move(origin, 360, 10, 3600);
    expect(north.x).toBeCloseTo(0, 6);
    expect(north.y).toBeCloseTo(10, 6);
    expect(bearingTo(origin, north)).toBeCloseTo(0, 6);

    const west = move(origin, -90, 10, 3600);
    expect(west.x).toBeCloseTo(-10, 6);
    expect(west.y).toBeCloseTo(0, 6);
    expect(bearingTo(origin, west)).toBeCloseTo(270, 6);
  });

  it('knotsToNmPerSec and velocityFrom convert speed correctly', () => {
    expect(knotsToNmPerSec(3600)).toBeCloseTo(1, 6);

    const velocity = velocityFrom(90, 3600);
    expect(velocity.x).toBeCloseTo(1, 6);
    expect(velocity.y).toBeCloseTo(0, 6);
  });

  it('fromBearingRange round-trips with bearingTo and rangeTo', () => {
    const bearings = [0, 45, 90, 135, 180, 225, 270, 315, 359];
    const origins: Vec2[] = [
      { x: 0, y: 0 },
      { x: 10, y: -5 },
    ];
    const rangeNm = 7;

    for (const originPoint of origins) {
      for (const bearingDeg of bearings) {
        const point = fromBearingRange(originPoint, bearingDeg, rangeNm);
        expect(bearingTo(originPoint, point)).toBeCloseTo(bearingDeg, 6);
        expect(rangeTo(originPoint, point)).toBeCloseTo(rangeNm, 6);
      }
    }
  });

  it('relativeMotion returns target-minus-own position and velocity', () => {
    const result = relativeMotion(
      { x: 1, y: 2 },
      { x: 3, y: 4 },
      { x: 10, y: 20 },
      { x: 5, y: 6 },
    );

    expect(result.relPos).toEqual({ x: 9, y: 18 });
    expect(result.relVel).toEqual({ x: 2, y: 2 });
  });

  it('cpa head-on', () => {
    const ownVel = velocityFrom(0, 10);
    const tgtVel = velocityFrom(180, 10);
    const result = cpa(origin, ownVel, { x: 0, y: 10 }, tgtVel);

    expect(result.tCpaSec).toBeCloseTo(1800, 6);
    expect(result.rangeNm).toBeCloseTo(0, 6);
  });

  it('cpa crossing with stationary own', () => {
    const ownVel: Vec2 = { x: 0, y: 0 };
    const tgtVel = velocityFrom(90, 10);
    const result = cpa(origin, ownVel, { x: -10, y: 5 }, tgtVel);

    expect(result.tCpaSec).toBeCloseTo(3600, 6);
    expect(result.rangeNm).toBeCloseTo(5, 6);
  });

  it('cpa crossing with both moving on collision course', () => {
    const ownVel = velocityFrom(0, 10);
    const tgtVel = velocityFrom(270, 10);
    const result = cpa(origin, ownVel, { x: 10, y: 10 }, tgtVel);

    expect(result.tCpaSec).toBeCloseTo(3600, 6);
    expect(result.rangeNm).toBeCloseTo(0, 6);
  });

  it('cpa crossing with both moving and a nonzero miss distance', () => {
    const ownVel = velocityFrom(0, 10);
    const tgtVel = velocityFrom(270, 10);
    const result = cpa(origin, ownVel, { x: 10, y: 12 }, tgtVel);

    expect(result.tCpaSec).toBeCloseTo(3960, 6);
    expect(result.rangeNm).toBeCloseTo(Math.SQRT2, 6);
    expect(result.rangeNm).toBeGreaterThan(0);
  });

  it('cpa opening', () => {
    const ownVel = velocityFrom(0, 10);
    const tgtVel = velocityFrom(0, 20);
    const result = cpa(origin, ownVel, { x: 0, y: 10 }, tgtVel);

    expect(result.tCpaSec).toBeCloseTo(0, 6);
    expect(result.rangeNm).toBeCloseTo(10, 6);
  });

  it('cpa with zero relative velocity', () => {
    const vel = velocityFrom(90, 10);
    const result = cpa(origin, vel, { x: 3, y: 4 }, vel);

    expect(result.tCpaSec).toBeCloseTo(0, 6);
    expect(result.rangeNm).toBeCloseTo(5, 6);
  });

  it('closingSpeed', () => {
    const ownVel = velocityFrom(0, 10);

    const headOnTgtVel = velocityFrom(180, 10);
    expect(closingSpeed(origin, ownVel, { x: 0, y: 10 }, headOnTgtVel)).toBeCloseTo(20, 6);

    const openingTgtVel = velocityFrom(0, 20);
    expect(closingSpeed(origin, ownVel, { x: 0, y: 10 }, openingTgtVel)).toBeCloseTo(-10, 6);

    const stationary: Vec2 = { x: 0, y: 0 };
    const crossingTgtVel = velocityFrom(90, 10);
    expect(closingSpeed(origin, stationary, { x: 0, y: 5 }, crossingTgtVel)).toBeCloseTo(0, 6);
  });

  it('angleDiff returns signed smallest difference', () => {
    const cases: Array<[number, number]> = [
      [angleDiff(350, 10), 20],
      [angleDiff(10, 350), -20],
      [angleDiff(0, 180), 180],
      [angleDiff(90, 90), 0],
      [angleDiff(-10, 10), 20],
      [angleDiff(720, 45), 45],
      [angleDiff(0, 181), -179],
    ];

    for (const [actual, expected] of cases) {
      expect(actual).toBeCloseTo(expected, 6);
      expect(actual).toBeGreaterThan(-180);
      expect(actual).toBeLessThanOrEqual(180);
    }
  });
});
