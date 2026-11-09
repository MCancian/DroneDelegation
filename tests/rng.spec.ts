import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/sim/rng';

describe('mulberry32', () => {
  it('produces identical sequences for the same seed', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA: number[] = [];
    const seqB: number[] = [];

    for (let i = 0; i < 100; i += 1) {
      seqA.push(a.next());
      seqB.push(b.next());
    }

    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA: number[] = [];
    const seqB: number[] = [];

    for (let i = 0; i < 100; i += 1) {
      seqA.push(a.next());
      seqB.push(b.next());
    }

    expect(seqA).not.toEqual(seqB);
  });

  it('returns values in [0,1) and has a reasonable mean', () => {
    const rng = mulberry32(987654321);
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;

    for (let i = 0; i < 10000; i += 1) {
      const v = rng.next();
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }

    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThan(1);
    expect(sum / 10000).toBeGreaterThanOrEqual(0.45);
    expect(sum / 10000).toBeLessThanOrEqual(0.55);
  });

  it('range stays within bounds, including negative bounds', () => {
    const rng = mulberry32(555);

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 10000; i += 1) {
      const v = rng.range(-10, -5);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(min).toBeGreaterThanOrEqual(-10);
    expect(max).toBeLessThan(-5);

    min = Infinity;
    max = -Infinity;
    for (let i = 0; i < 10000; i += 1) {
      const v = rng.range(0, 1);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThan(1);
  });

  it('chance respects 0 and 1 and approximates probabilities', () => {
    const rng = mulberry32(2468);

    let zeroAlwaysFalse = true;
    for (let i = 0; i < 1000; i += 1) {
      if (rng.chance(0)) zeroAlwaysFalse = false;
    }
    expect(zeroAlwaysFalse).toBe(true);

    let oneAlwaysTrue = true;
    for (let i = 0; i < 1000; i += 1) {
      if (!rng.chance(1)) oneAlwaysTrue = false;
    }
    expect(oneAlwaysTrue).toBe(true);

    let hits = 0;
    for (let i = 0; i < 10000; i += 1) {
      if (rng.chance(0.3)) hits += 1;
    }

    const freq = hits / 10000;
    expect(freq).toBeGreaterThanOrEqual(0.25);
    expect(freq).toBeLessThanOrEqual(0.35);
  });

  it('pick returns an element, covers all elements, and throws on empty', () => {
    const items = ['a', 'b', 'c'] as const;
    const rng = mulberry32(1357);
    const seen = new Set<string>();

    for (let i = 0; i < 300; i += 1) {
      const item = rng.pick(items);
      expect(items).toContain(item);
      seen.add(item);
    }

    expect(seen.size).toBe(3);

    const empty: readonly string[] = [];
    expect(() => rng.pick(empty)).toThrow('pick from empty array');
  });

  it('is deterministic across mixed method calls', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const items = ['x', 'y', 'z'] as const;

    const seqA = [
      a.next(),
      a.range(1, 2),
      a.chance(0.5),
      a.pick(items),
      a.next(),
      a.range(-1, 1),
      a.chance(0.25),
      a.pick(items),
    ];

    const seqB = [
      b.next(),
      b.range(1, 2),
      b.chance(0.5),
      b.pick(items),
      b.next(),
      b.range(-1, 1),
      b.chance(0.25),
      b.pick(items),
    ];

    expect(seqA).toEqual(seqB);
  });
});
