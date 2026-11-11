import type { Vec2 } from '../sim/types';

export const RANGE_SCALES: readonly number[] = [10, 20, 40, 80];
export const DEFAULT_RANGE_NM = 80;

export interface Projection {
  centerPx: Vec2;
  radiusPx: number;
  rangeNm: number;
  origin: Vec2;
}

export function makeProjection(
  widthPx: number,
  heightPx: number,
  rangeNm: number,
  origin: Vec2,
  paddingPx = 0,
): Projection {
  const centerPx: Vec2 = { x: widthPx / 2, y: heightPx / 2 };
  const radiusPx = Math.max(1, Math.min(widthPx, heightPx) / 2 - paddingPx);
  return { centerPx, radiusPx, rangeNm, origin };
}

export function pxPerNm(p: Projection): number {
  return p.rangeNm > 0 ? p.radiusPx / p.rangeNm : 0;
}

export function worldToScreen(p: Projection, pos: Vec2): Vec2 {
  const scale = pxPerNm(p);
  return {
    x: p.centerPx.x + (pos.x - p.origin.x) * scale,
    y: p.centerPx.y - (pos.y - p.origin.y) * scale,
  };
}

export function screenToWorld(p: Projection, px: number, py: number): Vec2 {
  const scale = pxPerNm(p);
  if (scale === 0) {
    return { x: p.origin.x, y: p.origin.y };
  }
  return {
    x: p.origin.x + (px - p.centerPx.x) / scale,
    y: p.origin.y + (p.centerPx.y - py) / scale,
  };
}

export function bearingToScreenAngle(bearingDeg: number): number {
  return ((bearingDeg - 90) * Math.PI) / 180;
}

export function pointAtBearing(
  p: Projection,
  bearingDeg: number,
  radiusPx: number,
): Vec2 {
  const angle = bearingToScreenAngle(bearingDeg);
  return {
    x: p.centerPx.x + Math.cos(angle) * radiusPx,
    y: p.centerPx.y + Math.sin(angle) * radiusPx,
  };
}

export function ringRadiiNm(rangeNm: number, count = 4): number[] {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return Array.from({ length: n }, (_, i) => (rangeNm * (i + 1)) / n);
}

export function clampRange(nm: number): number {
  let best = RANGE_SCALES[0] ?? nm;
  let bestDiff = Math.abs(nm - best);

  for (const scale of RANGE_SCALES) {
    const diff = Math.abs(nm - scale);
    if (diff < bestDiff) {
      best = scale;
      bestDiff = diff;
    }
  }

  return best;
}

export function nextRangeStep(currentNm: number, direction: 1 | -1): number {
  const exactIndex = RANGE_SCALES.indexOf(currentNm);
  if (exactIndex >= 0) {
    const nextIndex = Math.min(
      RANGE_SCALES.length - 1,
      Math.max(0, exactIndex + direction),
    );
    return RANGE_SCALES[nextIndex] ?? RANGE_SCALES[exactIndex] ?? currentNm;
  }

  const nearest = clampRange(currentNm);

  if (direction === 1 && currentNm < nearest) {
    return nearest;
  }
  if (direction === -1 && currentNm > nearest) {
    return nearest;
  }

  const nearestIndex = RANGE_SCALES.indexOf(nearest);
  if (nearestIndex < 0) {
    return nearest;
  }

  const nextIndex = Math.min(
    RANGE_SCALES.length - 1,
    Math.max(0, nearestIndex + direction),
  );
  return RANGE_SCALES[nextIndex] ?? nearest;
}

export function leaderLengthPx(
  speedKts: number,
  p: Projection,
  leaderMinutes = 1,
): number {
  if (speedKts <= 0 || leaderMinutes <= 0) {
    return 0;
  }

  const distanceNm = speedKts * (leaderMinutes / 60);
  return distanceNm * pxPerNm(p);
}

export function isInsideScope(p: Projection, pos: Vec2): boolean {
  const dx = pos.x - p.origin.x;
  const dy = pos.y - p.origin.y;
  return Math.hypot(dx, dy) <= p.rangeNm + 1e-9;
}

export const LEADER_MINUTES = 1;
export const LEADER_MAX_SCOPE_FRACTION = 0.15;

export function cappedLeaderLengthPx(
  speedKts: number,
  p: Projection,
  leaderMinutes = LEADER_MINUTES,
  maxFraction = LEADER_MAX_SCOPE_FRACTION,
): number {
  if (speedKts <= 0) {
    return 0;
  }
  return Math.min(
    leaderLengthPx(speedKts, p, leaderMinutes),
    p.radiusPx * maxFraction,
  );
}

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rectsOverlap(a: ScreenRect, b: ScreenRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export const RING_LABEL_CANDIDATE_BEARINGS: readonly number[] = [
  45, 135, 225, 315, 90, 270, 0, 180,
];

export function ringLabelRect(
  p: Projection,
  bearingDeg: number,
  ringRadiusPx: number,
  widthPx: number,
  heightPx: number,
): ScreenRect {
  const c = pointAtBearing(p, bearingDeg, ringRadiusPx);
  return {
    x: c.x - widthPx / 2,
    y: c.y - heightPx / 2,
    width: widthPx,
    height: heightPx,
  };
}

export function pickRingLabelBearing(
  p: Projection,
  ringRadiusPx: number,
  widthPx: number,
  heightPx: number,
  obstacles: readonly ScreenRect[],
  candidates: readonly number[] = RING_LABEL_CANDIDATE_BEARINGS,
): number {
  if (candidates.length === 0) {
    return 45;
  }

  for (const bearing of candidates) {
    const rect = ringLabelRect(p, bearing, ringRadiusPx, widthPx, heightPx);
    const hasOverlap = obstacles.some((obs) => rectsOverlap(rect, obs));
    if (!hasOverlap) {
      return bearing;
    }
  }

  let bestBearing = candidates[0] ?? 45;
  let bestCount = Infinity;

  for (const bearing of candidates) {
    const rect = ringLabelRect(p, bearing, ringRadiusPx, widthPx, heightPx);
    let count = 0;
    for (const obs of obstacles) {
      if (rectsOverlap(rect, obs)) {
        count += 1;
      }
    }
    if (count < bestCount) {
      bestCount = count;
      bestBearing = bearing;
    }
  }

  return bestBearing;
}
