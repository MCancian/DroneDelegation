import { describe, expect, it } from 'vitest';
import { autonomySnapshot, commandDomain, decide, setAutonomy } from '../src/ai/autonomy';
import { serializeSituation } from '../src/ai/situation';
import { executeCommand } from '../src/sim/commands';
import type { AutonomyLevel } from '../src/sim/types';
import { makeContact, makeWorld } from './helpers/sim';

describe('autonomy', () => {
  it.each([
    ['HOLD', 'advise_only'], ['CONSENT', 'needs_consent'],
    ['VETO', 'veto_window'], ['WEAPONS_FREE', 'execute'],
  ] as const)('routes %s to %s', (level, expected) => {
    expect(decide(level)).toBe(expected);
  });

  it('starts in HOLD and records only real changes with independent snapshots', () => {
    const w = makeWorld();
    expect(w.autonomy).toEqual({ air: 'HOLD', surface: 'HOLD' });
    expect(w.weapons.pointDefense).toBe('manual');
    setAutonomy(w, 'air', 'CONSENT');
    setAutonomy(w, 'air', 'CONSENT');
    setAutonomy(w, 'surface', 'WEAPONS_FREE');
    const changes = w.events.filter(e => e.type === 'autonomy_changed');
    expect(changes).toHaveLength(2);
    expect(changes[0].actor).toBe('player');
    expect(changes[0].payload).toMatchObject({ domain: 'air', previous: 'HOLD', level: 'CONSENT', autonomy: { air: 'CONSENT', surface: 'HOLD', pointDefense: 'manual' } });
    const snapshot = autonomySnapshot(w);
    snapshot.air = 'HOLD';
    expect(w.autonomy.air).toBe('CONSENT');
    setAutonomy(w, 'air', 'bogus' as AutonomyLevel);
    expect(w.events.filter(e => e.type === 'autonomy_changed')).toHaveLength(2);
  });

  it('records command-time levels, not later changes, including rejected attempts', () => {
    const w = makeWorld();
    setAutonomy(w, 'air', 'VETO');
    setAutonomy(w, 'surface', 'CONSENT');
    executeCommand(w, { action: 'maneuver', courseDeg: 90, speedKts: 10 }, 'player');
    executeCommand(w, { action: 'engage_sam', target: 'missing' }, 'ai-chat');
    setAutonomy(w, 'air', 'HOLD');
    const events = w.events.filter(e => e.type === 'command');
    expect(events).toHaveLength(2);
    expect(events.map(e => (e.payload as { autonomy: unknown }).autonomy)).toEqual([
      { air: 'VETO', surface: 'CONSENT' }, { air: 'VETO', surface: 'CONSENT' },
    ]);
  });

  it('uses only visible target domain and never authorizes untargeted or missing contacts', () => {
    const w = makeWorld([
      makeContact({ id: 'air', domain: 'air', position: { x: 0, y: 10 } }),
      makeContact({ id: 'surface', domain: 'surface', position: { x: 0, y: 8 } }),
      makeContact({ id: 'missile', domain: 'missile', position: { x: 0, y: 5 } }),
    ]);
    expect(commandDomain(w, { action: 'engage_sam', target: 'air' })).toBe('air');
    expect(commandDomain(w, { action: 'engage_gun', target: 'surface' })).toBe('surface');
    expect(commandDomain(w, { action: 'ciws', target: 'missile' })).toBe('air');
    expect(commandDomain(w, { action: 'engage_sam', target: 'missing' })).toBeNull();
    expect(commandDomain(w, { action: 'chaff' })).toBeNull();
  });

  it('reports actual levels to the assistant and logs point-defense changes', () => {
    const w = makeWorld();
    setAutonomy(w, 'air', 'WEAPONS_FREE');
    setAutonomy(w, 'surface', 'VETO');
    expect(serializeSituation(w)).toContain('AIR WEAPONS_FREE | SURFACE VETO');
    executeCommand(w, { action: 'set_point_defense', mode: 'auto' }, 'player');
    executeCommand(w, { action: 'set_point_defense', mode: 'auto' }, 'player');
    const pd = w.events.filter(e => e.type === 'autonomy_changed' && (e.payload as {domain: string}).domain === 'pointDefense');
    expect(pd).toHaveLength(1);
    expect(pd[0].payload).toMatchObject({ previous: 'manual', level: 'auto' });
  });
});
