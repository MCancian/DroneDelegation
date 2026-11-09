import { describe, expect, it, vi } from 'vitest';
import { GameClock } from '../src/sim/clock';

describe('GameClock', () => {
  describe('fixed-step advancement', () => {
    it('N steps advance time exactly', () => {
      const clock = new GameClock();
      expect(clock.advance(1)).toBe(10);
      expect(clock.steps).toBe(10);
      expect(clock.time).toBe(1);
    });

    it('partial steps accumulate across calls', () => {
      const clock = new GameClock();
      expect(clock.advance(0.35)).toBe(3);
      expect(clock.time).toBe(0.3);
      expect(clock.advance(0.05)).toBe(1);
      expect(clock.time).toBe(0.4);
    });

    it('loop of 37 advance(0.1) calls gives 37 steps', () => {
      const clock = new GameClock();
      for (let i = 0; i < 37; i++) {
        clock.advance(0.1);
      }
      expect(clock.steps).toBe(37);
      expect(clock.time).toBe(3.7);
    });

    it('100 calls of advance(1/60) give 16 steps', () => {
      const clock = new GameClock();
      for (let i = 0; i < 100; i++) {
        clock.advance(1 / 60);
      }
      expect(clock.steps).toBe(16);
    });
  });

  describe('onStep callbacks', () => {
    it('is called once per step with correct dtS and timeS', () => {
      const clock = new GameClock();
      const calls: Array<{ dtS: number; timeS: number }> = [];
      clock.onStep((dtS, timeS) => {
        calls.push({ dtS, timeS });
      });

      clock.advance(0.5);

      expect(calls.length).toBe(5);
      for (const call of calls) {
        expect(call.dtS).toBe(0.1);
      }
      expect(calls[4].timeS).toBe(0.5);
    });

    it('unsubscribe works', () => {
      const clock = new GameClock();
      const spy = vi.fn();
      const unsub = clock.onStep(spy);

      clock.advance(0.1);
      expect(spy).toHaveBeenCalledTimes(1);

      unsub();
      clock.advance(0.1);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('catch-up after hidden tab', () => {
    it('catch-up after 60 s gap produces 600 steps', () => {
      const clock = new GameClock();
      expect(clock.advance(1 / 60)).toBe(0);
      expect(clock.advance(60)).toBe(600);
      expect(clock.steps).toBe(600);
      expect(clock.time).toBe(60);
    });

    it('catch-up cap limits steps per call', () => {
      const clock = new GameClock();
      expect(clock.advance(300)).toBe(2000);
      expect(clock.pendingSteps).toBe(1000);
      expect(clock.advance(0)).toBe(1000);
      expect(clock.pendingSteps).toBe(0);
      expect(clock.time).toBe(300);
    });

    it('custom cap', () => {
      const clock = new GameClock({ maxStepsPerFrame: 50 });
      expect(clock.advance(10)).toBe(50);
      expect(clock.advance(0)).toBe(50);
      expect(clock.steps).toBe(100);
    });
  });

  describe('timescale', () => {
    it('timescale 4 honors multiplier', () => {
      const clock = new GameClock({ timescale: 4 });
      expect(clock.advance(1)).toBe(40);
      expect(clock.time).toBe(4);
    });

    it('timescale 0.5 honors multiplier', () => {
      const clock = new GameClock({ timescale: 0.5 });
      expect(clock.advance(1)).toBe(5);
    });

    it('timescale 0 falls back to 1', () => {
      const clock = new GameClock({ timescale: 0 });
      expect(clock.advance(1)).toBe(10);
    });
  });

  describe('invalid wall deltas', () => {
    it('negative, NaN, Infinity produce 0 steps', () => {
      const clock = new GameClock();
      expect(clock.advance(-1)).toBe(0);
      expect(clock.advance(NaN)).toBe(0);
      expect(clock.advance(Infinity)).toBe(0);
      expect(clock.time).toBe(0);
    });
  });

  describe('end', () => {
    it('fires once at 900 s', () => {
      const clock = new GameClock();
      const onEnd = vi.fn();
      clock.onEnd(onEnd);

      expect(clock.advance(1000)).toBe(2000);
      expect(clock.ended).toBe(false);

      expect(clock.advance(0)).toBe(2000);
      expect(clock.advance(0)).toBe(2000);
      expect(clock.advance(0)).toBe(2000);
      expect(clock.advance(0)).toBe(1000);

      expect(clock.steps).toBe(9000);
      expect(clock.time).toBe(900);
      expect(clock.ended).toBe(true);
      expect(onEnd).toHaveBeenCalledTimes(1);
      expect(onEnd).toHaveBeenCalledWith(900);

      expect(clock.advance(100)).toBe(0);
      expect(clock.advance(0)).toBe(0);
      expect(onEnd).toHaveBeenCalledTimes(1);
      expect(clock.time).toBe(900);
    });

    it('short clock ends correctly', () => {
      const clock = new GameClock({ durationS: 1 });
      const onEnd = vi.fn();
      clock.onEnd(onEnd);

      expect(clock.advance(5)).toBe(10);
      expect(clock.ended).toBe(true);
      expect(onEnd).toHaveBeenCalledTimes(1);
      expect(onEnd).toHaveBeenCalledWith(1);
    });

    it('end callback runs after final onStep', () => {
      const clock = new GameClock({ durationS: 0.2 });
      const order: string[] = [];
      clock.onStep(() => order.push('step'));
      clock.onEnd(() => order.push('end'));

      clock.advance(1);

      expect(order).toEqual(['step', 'step', 'end']);
    });
  });

  describe('no pause API', () => {
    it('has no pause, resume, or stop methods', () => {
      const clock = new GameClock();
      expect('pause' in clock).toBe(false);
      expect('resume' in clock).toBe(false);
      expect('stop' in clock).toBe(false);
    });
  });
});
