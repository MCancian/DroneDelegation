import type { Vec2 } from './types';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const NM_PER_SEC_PER_KNOT = 1 / 3600;
const EPS = 1e-12;

export function knotsToNmPerSec(speedKts: number): number {
  return speedKts * NM_PER_SEC_PER_KNOT;
}

export function normalizeDeg(deg: number): number {
  const m = deg % 360;
  const r = m < 0 ? m + 360 : m;
  if (r >= 360) return 0;
  return r === 0 ? 0 : r;
}

export function degToRad(deg: number): number {
  return deg * DEG_TO_RAD;
}

export function radToDeg(rad: number): number {
  return rad * RAD_TO_DEG;
}

export function rangeTo(from: Vec2, to: Vec2): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

export function bearingTo(from: Vec2, to: Vec2): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.hypot(dx, dy) <= EPS) return 0;
  const bearing = normalizeDeg(Math.atan2(dx, dy) * RAD_TO_DEG);
  return 360 - bearing <= 1e-9 ? 0 : bearing;
}

export function move(
  pos: Vec2,
  courseDeg: number,
  speedKts: number,
  dtSec: number,
): Vec2 {
  const distanceNm = speedKts * dtSec * NM_PER_SEC_PER_KNOT;
  const rad = degToRad(courseDeg);
  return {
    x: pos.x + distanceNm * Math.sin(rad),
    y: pos.y + distanceNm * Math.cos(rad),
  };
}

export function fromBearingRange(
  origin: Vec2,
  bearingDeg: number,
  rangeNm: number,
): Vec2 {
  const rad = degToRad(bearingDeg);
  return {
    x: origin.x + rangeNm * Math.sin(rad),
    y: origin.y + rangeNm * Math.cos(rad),
  };
}

export function velocityFrom(courseDeg: number, speedKts: number): Vec2 {
  const speedNmPerSec = knotsToNmPerSec(speedKts);
  const rad = degToRad(courseDeg);
  return {
    x: speedNmPerSec * Math.sin(rad),
    y: speedNmPerSec * Math.cos(rad),
  };
}

export interface RelativeMotion {
  relPos: Vec2;
  relVel: Vec2;
}

export function relativeMotion(
  ownPos: Vec2,
  ownVel: Vec2,
  tgtPos: Vec2,
  tgtVel: Vec2,
): RelativeMotion {
  return {
    relPos: {
      x: tgtPos.x - ownPos.x,
      y: tgtPos.y - ownPos.y,
    },
    relVel: {
      x: tgtVel.x - ownVel.x,
      y: tgtVel.y - ownVel.y,
    },
  };
}

export interface CpaResult {
  tCpaSec: number;
  rangeNm: number;
}

export function cpa(
  ownPos: Vec2,
  ownVel: Vec2,
  tgtPos: Vec2,
  tgtVel: Vec2,
): CpaResult {
  const { relPos, relVel } = relativeMotion(ownPos, ownVel, tgtPos, tgtVel);
  const currentRange = Math.hypot(relPos.x, relPos.y);
  const relVelSq = relVel.x * relVel.x + relVel.y * relVel.y;

  if (relVelSq <= EPS) {
    return { tCpaSec: 0, rangeNm: currentRange };
  }

  const t = -(relPos.x * relVel.x + relPos.y * relVel.y) / relVelSq;
  if (t <= EPS) {
    return { tCpaSec: 0, rangeNm: currentRange };
  }

  const closestX = relPos.x + relVel.x * t;
  const closestY = relPos.y + relVel.y * t;
  return {
    tCpaSec: t,
    rangeNm: Math.hypot(closestX, closestY),
  };
}

export function closingSpeed(
  ownPos: Vec2,
  ownVel: Vec2,
  tgtPos: Vec2,
  tgtVel: Vec2,
): number {
  const { relPos, relVel } = relativeMotion(ownPos, ownVel, tgtPos, tgtVel);
  const range = Math.hypot(relPos.x, relPos.y);
  if (range <= EPS) return 0;

  const rangeRateNmPerSec =
    (relVel.x * relPos.x + relVel.y * relPos.y) / range;
  const closingKts = -rangeRateNmPerSec / NM_PER_SEC_PER_KNOT;
  return Math.abs(closingKts) <= EPS ? 0 : closingKts;
}

/**
 * Signed smallest difference b - a in degrees, normalized to (-180, 180].
 * Positive means b is clockwise from a; negative means b is counter-clockwise.
 */
export function angleDiff(a: number, b: number): number {
  const d = normalizeDeg(b - a);
  return d > 180 ? d - 360 : d;
}
