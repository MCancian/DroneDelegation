import type { Vec2 } from '../sim/types';
import { rectsOverlap } from './radarProjection';
import type { ScreenRect } from './radarProjection';

/** A label's size is measured by the canvas; priority is selected, missile, then other. */
export interface RadarLabelRequest {
  id: string;
  anchor: Vec2;
  width: number;
  height: number;
  priority: number;
}

export interface RadarLabelPlacement extends ScreenRect {
  id: string;
}

/**
 * Place higher priority labels first. Suppress labels that cannot be placed rather
 * than obscuring tracks or other labels. Track symbols and picking remain intact.
 */
export function layoutRadarLabels(
  requests: readonly RadarLabelRequest[],
  width: number,
  height: number,
  obstacles: readonly ScreenRect[],
): RadarLabelPlacement[] {
  const placed: RadarLabelPlacement[] = [];
  const occupied: ScreenRect[] = [...obstacles];
  const sorted = [...requests].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  for (const request of sorted) {
    const { anchor, width: w, height: h } = request;
    if (w <= 0 || h <= 0 || w > width || h > height) continue;
    // Grid cells are sized to the label, with a small gap. The search starts
    // near the symbol and spreads out in stable square rings.
    const baseX = anchor.x + 17;
    const baseY = anchor.y - 15 - h;
    let found: RadarLabelPlacement | undefined;
    for (let ring = 0; ring <= 12 && !found; ring++) {
      const candidates: { x: number; y: number }[] = [];
      for (let x = -ring; x <= ring; x++) {
        for (let y = -ring; y <= ring; y++) {
          if (Math.max(Math.abs(x), Math.abs(y)) !== ring) continue;
          candidates.push({ x, y });
        }
      }
      candidates.sort((a, b) => a.x * a.x + a.y * a.y - b.x * b.x - b.y * b.y || a.y - b.y || a.x - b.x);
      for (const offset of candidates) {
        const rect = { id: request.id, x: Math.max(1, Math.min(width - 1 - w, baseX + offset.x * (w + 4))), y: Math.max(1, Math.min(height - 1 - h, baseY + offset.y * (h + 4))), width: w, height: h };
        if (rect.x < 1 || rect.y < 1 || rect.x + w > width - 1 || rect.y + h > height - 1) continue;
        if (occupied.some((other) => rectsOverlap(rect, other))) continue;
        found = rect;
        break;
      }
    }
    if (found) {
      placed.push(found);
      occupied.push(found);
    }
  }
  return placed;
}
