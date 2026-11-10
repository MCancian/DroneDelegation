import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT } from '../src/ai/systemPrompt';

describe('SYSTEM_PROMPT', () => {
  it('contains ROE-3 verbatim text', () => {
    expect(SYSTEM_PROMPT).toContain('Any air contact approaching from Red territory whose altitude and speed match');
    expect(SYSTEM_PROMPT).toContain('engaged before it reaches 30 nm');
    expect(SYSTEM_PROMPT).toContain('Hesitation against a known attack profile costs the ship');
  });

  it('contains ROE-5 verbatim text', () => {
    expect(SYSTEM_PROMPT).toContain('A small surface contact with no AIS that departs a group and closes at > 30 kts');
    expect(SYSTEM_PROMPT).toContain('recommend or conduct engagement before 6 nm');
  });

  it('does not contain scenario-specific contact IDs', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\bA-1\b/);
    expect(SYSTEM_PROMPT).not.toMatch(/\bA-9\b/);
    expect(SYSTEM_PROMPT).not.toMatch(/\bS-7\b/);
    expect(SYSTEM_PROMPT).not.toMatch(/\ba1\b/);
    expect(SYSTEM_PROMPT).not.toMatch(/\ba9\b/);
    expect(SYSTEM_PROMPT).not.toMatch(/\bs7\b/);
  });

  it('does not contain scenario-specific timings', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\bT\+\d/);
    expect(SYSTEM_PROMPT).not.toMatch(/\bat \d+ ?nm/);
    expect(SYSTEM_PROMPT).not.toMatch(/\b540\b/);
    expect(SYSTEM_PROMPT).not.toMatch(/\b480\b/);
  });

  it('mentions 35kt speed cap', () => {
    expect(SYSTEM_PROMPT).toContain('35');
  });

  it('uses generic TRACK-ID in examples', () => {
    expect(SYSTEM_PROMPT).toContain('TRACK-ID');
  });

  it('is a non-empty string', () => {
    expect(typeof SYSTEM_PROMPT).toBe('string');
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });
});
