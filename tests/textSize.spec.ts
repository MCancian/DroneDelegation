import { describe, expect, it } from 'vitest';
import { readTextSize, saveTextSize, TEXT_SIZE_KEY } from '../src/ui/textSize';

describe('text size preference', () => {
  it('restores a saved choice and defaults safely for absent or unexpected values', () => {
    let saved: string | null = null;
    const storage = {
      getItem: (key: string) => key === TEXT_SIZE_KEY ? saved : null,
      setItem: (key: string, value: string) => { if (key === TEXT_SIZE_KEY) saved = value; },
    };
    expect(readTextSize(storage)).toBe('standard');
    saveTextSize(storage, 'large');
    expect(readTextSize(storage)).toBe('large');
    for (const value of ['huge', '__proto__', 'constructor', '']) {
      saved = value;
      expect(readTextSize(storage)).toBe('standard');
    }
  });

  it('keeps a usable default when reading or saving storage throws', () => {
    const storage = {
      getItem: () => { throw new Error('Storage denied'); },
      setItem: () => { throw new Error('Storage denied'); },
    };
    expect(readTextSize(storage)).toBe('standard');
    expect(() => saveTextSize(storage, 'large')).not.toThrow();
  });
});
