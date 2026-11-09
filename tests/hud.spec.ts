import { describe, it, expect } from 'vitest';
import { formatClock } from '../src/ui/hud';

describe('formatClock', () => {
  it('formats zero', () => {
    expect(formatClock(0)).toBe('00:00 / 15:00');
  });

  it('floors elapsed seconds', () => {
    expect(formatClock(59.95)).toBe('00:59 / 15:00');
  });

  it('formats one minute one second', () => {
    expect(formatClock(61)).toBe('01:01 / 15:00');
  });

  it('formats ten minutes', () => {
    expect(formatClock(600.4)).toBe('10:00 / 15:00');
  });

  it('formats exactly duration', () => {
    expect(formatClock(900)).toBe('15:00 / 15:00');
  });

  it('clamps above duration', () => {
    expect(formatClock(1200)).toBe('15:00 / 15:00');
  });

  it('clamps below zero', () => {
    expect(formatClock(-3)).toBe('00:00 / 15:00');
  });

  it('treats NaN as zero', () => {
    expect(formatClock(NaN)).toBe('00:00 / 15:00');
  });

  it('accepts custom duration', () => {
    expect(formatClock(30, 60)).toBe('00:30 / 01:00');
  });
});
