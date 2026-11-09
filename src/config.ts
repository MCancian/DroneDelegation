export interface GameConfig {
  timescale: number;
  seed: number;
}

export const DEFAULT_TIMESCALE = 1;
export const MIN_TIMESCALE = 0.1;
export const MAX_TIMESCALE = 100;

/**
 * Parse URL search params into a GameConfig.
 *
 * `allowTimescale` must be true for `?timescale` to take effect (dev builds only
 * per DESIGN.md §1 — "There is no pause"). When false, timescale is always
 * DEFAULT_TIMESCALE regardless of the URL. Seed parsing is unaffected.
 */
export function parseConfig(search: string, fallbackSeed: number, allowTimescale: boolean): GameConfig {
  const params = new URLSearchParams(search);

  let timescale = DEFAULT_TIMESCALE;
  if (allowTimescale) {
    const tsRaw = params.get('timescale');
    if (tsRaw !== null && tsRaw.trim() !== '') {
      const ts = Number(tsRaw);
      if (Number.isFinite(ts) && ts > 0) {
        timescale = Math.min(MAX_TIMESCALE, Math.max(MIN_TIMESCALE, ts));
      }
    }
  }

  let seed = fallbackSeed >>> 0;
  const seedRaw = params.get('seed');
  if (seedRaw !== null && seedRaw.trim() !== '') {
    const s = Number(seedRaw);
    if (Number.isInteger(s) && s >= 0 && s <= 4294967295) {
      seed = s;
    }
  }

  return { timescale, seed };
}

export function randomSeed(random: () => number = Math.random): number {
  return Math.floor(random() * 4294967296) >>> 0;
}
