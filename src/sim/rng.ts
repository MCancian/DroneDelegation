export interface Rng {
  next(): number;
  chance(p: number): boolean;
  range(a: number, b: number): number;
  pick<T>(arr: readonly T[]): T;
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;

  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    chance(p: number): boolean {
      const q = p < 0 ? 0 : p > 1 ? 1 : p;
      return next() < q;
    },
    range(lo: number, hi: number): number {
      return lo + (hi - lo) * next();
    },
    pick<T>(arr: readonly T[]): T {
      if (arr.length === 0) {
        throw new Error('pick from empty array');
      }
      return arr[Math.floor(next() * arr.length)];
    },
  };
}
