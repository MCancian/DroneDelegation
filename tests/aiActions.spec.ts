import { describe, it, expect } from 'vitest';
import { parseActions } from '../src/ai/actions';
import { makeWorld, makeContact, stepWorld } from './helpers/sim';
import type { World } from '../src/sim/world';

function worldWithTrack(trackId: string, id: string, opts?: { ownMissile?: boolean; domain?: 'air' | 'surface' | 'missile' }): World {
  const c = makeContact({ id, trackId, domain: opts?.domain ?? 'air', ownMissile: opts?.ownMissile });
  const w = makeWorld([c]);
  stepWorld(w, 5);
  return w;
}

describe('parseActions', () => {
  it('parses multiple action blocks', () => {
    const w = worldWithTrack('A-01', 'a1');
    const text = '```action\n{"action":"engage_sam","target":"A-01"}\n```\n```action\n{"action":"chaff"}\n```';
    const { commands, errors } = parseActions(text, w);
    expect(errors).toHaveLength(0);
    expect(commands).toHaveLength(2);
    expect(commands[0].action).toBe('engage_sam');
    expect(commands[1].action).toBe('chaff');
  });

  it('rejects malformed JSON', () => {
    const w = worldWithTrack('A-01', 'a1');
    const { commands, errors } = parseActions('```action\n{bad json}\n```', w);
    expect(commands).toHaveLength(0);
    expect(errors[0]).toContain('Malformed JSON');
  });

  it('parses the reported pair of hail objects in one action block', () => {
    const w = makeWorld([
      makeContact({ id: 's5', trackId: 'S-05', domain: 'surface' }),
      makeContact({ id: 's8', trackId: 'S-08', domain: 'surface' }),
    ]);
    stepWorld(w, 5);
    const text = '```action\n'
      + '{"action":"hail","target":"S-05","reason":"unknown no-AIS closing contact"}\n'
      + '{"action":"hail","target":"S-08","reason":"unknown no-AIS closing contact"}\n```';
    expect(parseActions(text, w)).toEqual({
      commands: [{ action: 'hail', target: 's5' }, { action: 'hail', target: 's8' }],
      errors: [],
    });
  });

  it('still validates every object in a multi-object block', () => {
    const w = worldWithTrack('A-01', 'a1');
    const text = '```action\n{"action":"chaff"}\n{"action":"engage_sam","target":"missing"}\n```';
    const { commands, errors } = parseActions(text, w);
    expect(commands).toEqual([{ action: 'chaff' }]);
    expect(errors).toEqual(["Target 'missing' not found among visible tracks"]);
  });

  it('rejects an entire malformed sequence without salvaging commands', () => {
    const w = worldWithTrack('A-01', 'a1');
    const text = '```action\n{"action":"chaff"}\n{bad json}\n```';
    expect(parseActions(text, w)).toEqual({ commands: [], errors: ['Malformed JSON in action block'] });
  });

  it('rejects unknown action', () => {
    const w = worldWithTrack('A-01', 'a1');
    const { commands, errors } = parseActions('```action\n{"action":"launch_nuke","target":"A-01"}\n```', w);
    expect(commands).toHaveLength(0);
    expect(errors[0]).toContain('Unknown');
  });

  it('rejects schema errors (missing target)', () => {
    const w = worldWithTrack('A-01', 'a1');
    const { commands, errors } = parseActions('```action\n{"action":"engage_sam"}\n```', w);
    expect(commands).toHaveLength(0);
    expect(errors[0]).toContain('target');
  });

  it('rejects unknown fields', () => {
    const w = worldWithTrack('A-01', 'a1');
    const { commands, errors } = parseActions('```action\n{"action":"engage_sam","target":"A-01","extra":1}\n```', w);
    expect(commands).toHaveLength(0);
    expect(errors[0]).toContain('Unknown field');
  });

  it('enforces 35kt maneuver cap', () => {
    const w = worldWithTrack('A-01', 'a1');
    const { commands, errors } = parseActions('```action\n{"action":"maneuver","courseDeg":180,"speedKts":40}\n```', w);
    expect(commands).toHaveLength(0);
    expect(errors[0]).toContain('speedKts');
  });

  it('accepts valid maneuver within cap', () => {
    const w = worldWithTrack('A-01', 'a1');
    const { commands, errors } = parseActions('```action\n{"action":"maneuver","courseDeg":180,"speedKts":30}\n```', w);
    expect(errors).toHaveLength(0);
    expect(commands[0]).toEqual({ action: 'maneuver', courseDeg: 180, speedKts: 30 });
  });

  it('resolves exact displayed trackId to internal id', () => {
    const w = worldWithTrack('A-01', 'a1');
    const { commands } = parseActions('```action\n{"action":"engage_sam","target":"A-01"}\n```', w);
    expect(commands[0]).toEqual({ action: 'engage_sam', target: 'a1' });
  });

  it('rejects internal id as target', () => {
    const w = worldWithTrack('A-01', 'a1');
    const { commands, errors } = parseActions('```action\n{"action":"engage_sam","target":"a1"}\n```', w);
    expect(commands).toHaveLength(0);
    expect(errors[0]).toContain('not found');
  });

  it('rejects ambiguous duplicated trackId', () => {
    const c1 = makeContact({ id: 'x1', trackId: 'A-01', domain: 'air' });
    const c2 = makeContact({ id: 'x2', trackId: 'A-01', domain: 'air' });
    const w = makeWorld([c1, c2]);
    stepWorld(w, 5);
    // Force duplicate displayed trackId in sensor state
    w.sensors.tracks['x2'].trackId = w.sensors.tracks['x1'].trackId;
    const { commands, errors } = parseActions('```action\n{"action":"engage_sam","target":"A-01"}\n```', w);
    expect(commands).toHaveLength(0);
    expect(errors[0]).toContain('Ambiguous');
  });

  it('rejects ambiguity when one match is own interceptor', () => {
    const c1 = makeContact({ id: 'x1', trackId: 'A-01', domain: 'air' });
    const c2 = makeContact({ id: 'x2', trackId: 'A-01', domain: 'missile', ownMissile: true });
    const w = makeWorld([c1, c2]);
    stepWorld(w, 5);
    w.sensors.tracks['x2'].trackId = w.sensors.tracks['x1'].trackId;
    const { commands, errors } = parseActions('```action\n{"action":"engage_sam","target":"A-01"}\n```', w);
    expect(commands).toHaveLength(0);
    expect(errors[0]).toContain('Ambiguous');
  });

  it('rejects own interceptor target', () => {
    const w = worldWithTrack('M-01', 'm1', { ownMissile: true, domain: 'missile' });
    const { commands, errors } = parseActions('```action\n{"action":"engage_sam","target":"M-01"}\n```', w);
    expect(commands).toHaveLength(0);
    expect(errors[0]).toContain('own interceptor');
  });

  it('rejects out-of-range SAM target', () => {
    const c = makeContact({ id: 'far', trackId: 'A-99', domain: 'air', position: { x: 0, y: 80 } });
    const w = makeWorld([c]);
    stepWorld(w, 5);
    const { commands, errors } = parseActions('```action\n{"action":"engage_sam","target":"A-99"}\n```', w);
    expect(commands).toHaveLength(0);
    expect(errors[0]).toContain('range');
  });

  it('handles array of objects in one block', () => {
    const w = worldWithTrack('A-01', 'a1');
    const { commands, errors } = parseActions('```action\n[{"action":"chaff"},{"action":"set_point_defense","mode":"auto"}]\n```', w);
    expect(errors).toHaveLength(0);
    expect(commands).toHaveLength(2);
  });

  it('tolerates CRLF and extra whitespace', () => {
    const w = worldWithTrack('A-01', 'a1');
    const { commands, errors } = parseActions('```action\r\n  {"action":"chaff"}  \r\n```', w);
    expect(errors).toHaveLength(0);
    expect(commands).toHaveLength(1);
  });

  it('ignores valid reason field', () => {
    const w = worldWithTrack('A-01', 'a1');
    const { commands, errors } = parseActions('```action\n{"action":"engage_sam","target":"A-01","reason":"test"}\n```', w);
    expect(errors).toHaveLength(0);
    expect(commands[0]).toEqual({ action: 'engage_sam', target: 'a1' });
  });

  it('rejects non-string reason', () => {
    const w = worldWithTrack('A-01', 'a1');
    const { commands, errors } = parseActions('```action\n{"action":"engage_sam","target":"A-01","reason":42}\n```', w);
    expect(commands).toHaveLength(0);
    expect(errors[0]).toContain('reason');
  });

  it('rejects null entry', () => {
    const w = worldWithTrack('A-01', 'a1');
    const { commands, errors } = parseActions('```action\nnull\n```', w);
    expect(commands).toHaveLength(0);
    expect(errors[0]).toContain('object');
  });
});
