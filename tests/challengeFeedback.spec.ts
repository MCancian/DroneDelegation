import { describe, expect, it } from 'vitest';
import { executeCommand, validateCommand } from '../src/sim/commands';
import { isEventOfType } from '../src/sim/events';
import { stepCrew } from '../src/sim/scenario/crew';
import type { IffInfo } from '../src/sim/types';
import { makeContact, makeWorld, stepWorldWithCrew } from './helpers/sim';

function challengeReports(world: ReturnType<typeof makeWorld>) {
  return world.events
    .filter((event) => isEventOfType(event, 'crew-report'))
    .filter((event) => event.payload.station === 'TAO-Air' && event.payload.contactId === 'tgt');
}

describe('IFF challenge feedback', () => {
  for (const [iff, result] of [
    [{ kind: 'none' }, 'no IFF response'],
    [{ kind: 'mode3', code: '1234' }, 'IFF response received'],
    [{ kind: 'mode4' }, 'IFF verifies a friendly aircraft'],
  ] as const satisfies readonly (readonly [IffInfo, string])[]) {
    it(`acknowledges a pending challenge and reports ${iff.kind} after the response delay`, () => {
      const world = makeWorld([makeContact({ responses: { iff } })]);
      stepCrew(world);
      expect(executeCommand(world, { action: 'iff_challenge', target: 'tgt' }, 'player')).toEqual({ ok: true });
      stepCrew(world);

      const pending = challengeReports(world);
      expect(pending).toHaveLength(1);
      expect(pending[0].payload.trackId).toBe('A-01');
      expect(pending[0].payload.text).toContain('awaiting response');
      expect(validateCommand(world, { action: 'iff_challenge', target: 'tgt' })).toEqual({
        ok: false,
        error: 'Awaiting IFF response from A-01',
      });
      expect(executeCommand(world, { action: 'iff_challenge', target: 'tgt' }, 'player').ok).toBe(false);
      stepWorldWithCrew(world, 4.9);
      expect(challengeReports(world)).toHaveLength(1);
      stepWorldWithCrew(world, 0.1);
      const reports = challengeReports(world);
      expect(reports).toHaveLength(2);
      expect(reports[1].payload.text).toContain(result);
      expect(reports[1].payload.trackId).toBe('A-01');
      expect(validateCommand(world, { action: 'iff_challenge', target: 'tgt' })).toEqual({ ok: true });
    });
  }

  it('reports a requested result even when that IFF value was already known', () => {
    const world = makeWorld([makeContact({
      sensors: { iff: { kind: 'mode3', code: '1234' }, ais: { kind: 'none' }, esm: { kind: 'none' }, visual: { kind: 'none' } },
    })]);
    stepCrew(world);
    expect(world.events.filter((event) => isEventOfType(event, 'crew-report') && event.payload.text.includes('squawking Mode 3'))).toHaveLength(1);
    executeCommand(world, { action: 'iff_challenge', target: 'tgt' }, 'player');
    stepCrew(world);
    stepWorldWithCrew(world, 5);
    expect(challengeReports(world).filter((event) => event.payload.text.includes('IFF response received'))).toHaveLength(1);
    expect(challengeReports(world).filter((event) => event.payload.text.includes('awaiting response'))).toHaveLength(1);
  });
});
