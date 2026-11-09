export interface GameConfig {
  timescale: number;
  seed: number;
}

export const DEFAULT_TIMESCALE = 1;

export function parseConfig(search: string, fallbackSeed: number): GameConfig {
  const params = new URLSearchParams(search);

  let timescale = DEFAULT_TIMESCALE;
  const tsRaw = params.get('timescale');
  if (tsRaw !== null && tsRaw.trim() !== '') {
    const ts = Number(tsRaw);
    if (Number.isFinite(ts) && ts > 0) {
      timescale = ts;
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
