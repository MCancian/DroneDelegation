import { describe, expect, it } from 'vitest';
import { parseConfig, randomSeed, MIN_TIMESCALE, MAX_TIMESCALE } from '../src/config';

describe('MIN_TIMESCALE / MAX_TIMESCALE', () => {
  it('MIN_TIMESCALE is 0.1', () => {
    expect(MIN_TIMESCALE).toBe(0.1);
  });

  it('MAX_TIMESCALE is 100', () => {
    expect(MAX_TIMESCALE).toBe(100);
  });
});

describe('parseConfig', () => {
  it('returns defaults for empty search', () => {
    expect(parseConfig('', 7, true)).toEqual({ timescale: 1, seed: 7 });
  });

  it('parses timescale and seed with leading ?', () => {
    expect(parseConfig('?timescale=4&seed=42', 7, true)).toEqual({ timescale: 4, seed: 42 });
  });

  it('parses timescale without leading ?', () => {
    expect(parseConfig('timescale=0.5', 7, true).timescale).toBe(0.5);
  });

  it('falls back to default timescale for invalid values', () => {
    expect(parseConfig('timescale=0', 7, true).timescale).toBe(1);
    expect(parseConfig('timescale=-2', 7, true).timescale).toBe(1);
    expect(parseConfig('timescale=abc', 7, true).timescale).toBe(1);
    expect(parseConfig('timescale=', 7, true).timescale).toBe(1);
  });

  it('falls back to fallbackSeed for invalid seed values', () => {
    expect(parseConfig('seed=abc', 7, true).seed).toBe(7);
    expect(parseConfig('seed=3.7', 7, true).seed).toBe(7);
    expect(parseConfig('seed=-1', 7, true).seed).toBe(7);
    expect(parseConfig('seed=4294967296', 7, true).seed).toBe(7);
  });

  it('accepts boundary seed values', () => {
    expect(parseConfig('seed=0', 7, true).seed).toBe(0);
    expect(parseConfig('seed=4294967295', 7, true).seed).toBe(4294967295);
  });

  it('treats empty seed value as missing', () => {
    expect(parseConfig('seed=', 7, true).seed).toBe(7);
  });

  it('treats whitespace-only seed value as missing', () => {
    expect(parseConfig('?seed=%20', 7, true).seed).toBe(7);
  });

  it('treats whitespace-only timescale as missing while parsing valid seed', () => {
    expect(parseConfig('timescale=%20&seed=5', 7, true)).toEqual({ timescale: 1, seed: 5 });
  });

  it('parses both seed and timescale together', () => {
    expect(parseConfig('seed=12&timescale=2', 7, true)).toEqual({ timescale: 2, seed: 12 });
  });

  it('reduces fallback seed with >>> 0', () => {
    expect(parseConfig('', 4294967297, true).seed).toBe(1);
  });

  it('production ignores timescale but keeps seed', () => {
    expect(parseConfig('?timescale=4&seed=42', 7, false)).toEqual({ timescale: 1, seed: 42 });
  });

  it('production ignores tiny timescale', () => {
    expect(parseConfig('timescale=0.0001', 7, false).timescale).toBe(1);
  });

  it('dev clamps below MIN_TIMESCALE', () => {
    expect(parseConfig('timescale=0.0001', 7, true).timescale).toBe(0.1);
  });

  it('dev clamps above MAX_TIMESCALE', () => {
    expect(parseConfig('timescale=1000', 7, true).timescale).toBe(100);
  });

  it('dev accepts MIN_TIMESCALE boundary', () => {
    expect(parseConfig('timescale=0.1', 7, true).timescale).toBe(0.1);
  });

  it('dev accepts MAX_TIMESCALE boundary', () => {
    expect(parseConfig('timescale=100', 7, true).timescale).toBe(100);
  });

  it('dev falls back for Infinity', () => {
    expect(parseConfig('timescale=Infinity', 7, true).timescale).toBe(1);
  });
});

describe('randomSeed', () => {
  it('returns 0 for random() = 0', () => {
    expect(randomSeed(() => 0)).toBe(0);
  });

  it('returns 2147483648 for random() = 0.5', () => {
    expect(randomSeed(() => 0.5)).toBe(2147483648);
  });

  it('returns 4294967295 for random() near 1', () => {
    expect(randomSeed(() => 0.999999999999)).toBe(4294967295);
  });
});
