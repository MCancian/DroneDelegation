import { describe, expect, it } from 'vitest';
import { layoutRadarLabels } from '../src/ui/radarLabels';
import { rectsOverlap } from '../src/ui/radarProjection';

const fleet = Array.from({ length: 6 }, (_, i) => ({
  id: `S-0${i + 1}`, anchor: { x: 355 + i * 2, y: 208 + i }, width: 45, height: 26, priority: 0,
}));
const symbols = fleet.map(({ anchor }) => ({ x: anchor.x - 9, y: anchor.y - 9, width: 18, height: 18 }));

describe('radar label placement', () => {
  it('separates a crowded fishing fleet and avoids the track symbols', () => {
    const labels = layoutRadarLabels(fleet, 720, 520, symbols);
    expect(labels).toHaveLength(6);
    for (const [i, label] of labels.entries()) {
      expect(label.x).toBeGreaterThanOrEqual(0);
      expect(label.y).toBeGreaterThanOrEqual(0);
      expect(label.x + label.width).toBeLessThanOrEqual(720);
      expect(label.y + label.height).toBeLessThanOrEqual(520);
      expect(symbols.some(symbol => rectsOverlap(label, symbol))).toBe(false);
      expect(labels.slice(i + 1).some(other => rectsOverlap(label, other))).toBe(false);
    }
  });

  it('is deterministic regardless of input ordering', () => {
    expect(layoutRadarLabels(fleet, 720, 520, symbols)).toEqual(layoutRadarLabels([...fleet].reverse(), 720, 520, symbols));
  });

  it('keeps high priority labels when there is insufficient space', () => {
    const same = { anchor: { x: 0, y: 0 }, width: 45, height: 26 };
    const labels = layoutRadarLabels([
      { ...same, id: 'ordinary', priority: 0 },
      { ...same, id: 'selected', priority: 2 },
      { ...same, id: 'missile', priority: 1 },
    ], 50, 30, []);
    expect(labels.map(label => label.id)).toEqual(['selected']);
  });

  it('brings edge labels within the canvas', () => {
    const labels = layoutRadarLabels([{ id: 'edge', anchor: { x: 639, y: 1 }, width: 45, height: 39, priority: 0 }], 640, 480, []);
    expect(labels).toHaveLength(1);
    expect(labels[0].x + labels[0].width).toBeLessThan(640);
    expect(labels[0].y).toBeGreaterThanOrEqual(0);
  });
});
