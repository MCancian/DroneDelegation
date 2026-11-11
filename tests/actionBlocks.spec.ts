import { describe, it, expect } from 'vitest';
import { decodeActionBlock } from '../src/ai/actionBlocks';

describe('decodeActionBlock', () => {
  const first = { action: 'hail', target: 'S-05', reason: 'Braces { } and "quotes" and a backslash \\' };
  const second = { action: 'maneuver', courseDeg: 180, speedKts: 20 };

  it('accepts a single object and an array', () => {
    expect(decodeActionBlock(JSON.stringify(first))).toEqual([first]);
    expect(decodeActionBlock(JSON.stringify([first, second]))).toEqual([first, second]);
  });

  it.each(['\n', '\r\n', ' \t '])('accepts pretty-printed objects separated by %j', (separator) => {
    const content = [first, second].map(item => JSON.stringify(item, null, 2)).join(separator);
    expect(decodeActionBlock(` \n${content}\n `)).toEqual([first, second]);
  });

  it('keeps nested values intact for subsequent schema validation', () => {
    const nested = { action: 'chaff', extra: { values: [{ text: '}' }] } };
    expect(decodeActionBlock(`${JSON.stringify(nested)}\n${JSON.stringify(second)}`)).toEqual([nested, second]);
  });

  it.each([
    '',
    '{bad json}',
    '{"action":"chaff"}\n{"action":"hail"',
    '{"action":"chaff"}\n{"action":"hail",}',
    '{"action":"chaff"},\n{"action":"chaff"}',
    '{"action":"chaff"}{"action":"chaff"}',
    '{"action":"chaff"}\n// comment\n{"action":"chaff"}',
    '{"action":"chaff"}\nprose',
  ])('rejects malformed content atomically: %j', (content) => {
    expect(() => decodeActionBlock(content)).toThrow(SyntaxError);
  });
});
