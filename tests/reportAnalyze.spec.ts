import { describe, expect, it } from 'vitest';
import { analyze, type ScenarioMeta } from '../src/report/analyze';
import { STRAIT_TRANSIT } from '../src/sim/scenario/strait';
import type { Actor, GameEvent } from '../src/sim/types';

const meta: ScenarioMeta = { scenario: STRAIT_TRANSIT, seed: 123, endedAtS: 900, hullPct: 60, shipLost: false };
function event(t: number, type: string, payload: unknown, actor: Actor = 'scenario'): GameEvent { return { t, type, payload, actor }; }
function command(t: number, target: string, actor: Actor, domain: 'air' | 'surface', level: string, ok = true): GameEvent {
  return event(t, 'command', { command: { action: domain === 'air' ? 'engage_sam' : 'engage_gun', target }, ok, ...(ok ? {} : { error: 'out of range' }), autonomy: { air: domain === 'air' ? level : 'HOLD', surface: domain === 'surface' ? level : 'HOLD' } }, actor);
}
function fire(t: number, target: string, actor: Actor, weapon: string): GameEvent { return event(t, 'weapon_fired', { weapon, targetId: target, targetTrackId: target === 'a9' ? 'A-09' : 'S-07', rangeNm: weapon === 'sam' ? 38 : 6 }, actor); }
function death(t: number, contactId: string, truth: string, casualties: number, actor: Actor): GameEvent { return event(t, 'contact_destroyed', { contactId, truth, casualties, domain: contactId === 'a9' ? 'air' : 'surface' }, actor); }

const inbound = [event(310, 'ascm_launched', { missileId: 'm1' }), event(311, 'ascm_launched', { missileId: 'm2' }),
  event(400, 'contact_destroyed', { contactId: 'm1', domain: 'missile', truth: 'hostile', casualties: 0 }, 'crew-auto'),
  event(401, 'missile_impact', { missileId: 'm2', hit: true, hullPct: 60 })];

describe('deterministic after-action analysis', () => {
  it('summarizes an all-HOLD playthrough with a hit and no civilian loss', () => {
    const events = [...inbound, event(300, 'missile-launch', { launcherId: 'a1', rangeNm: 29.9 }), event(600, 'missile-launch', { launcherId: 's7', rangeNm: 4.9 })];
    const report = analyze(events, meta);
    expect(report.summary).toEqual({ hullPct: 60, missilesInbound: 2, missilesHit: 1, missilesDefeated: 1, missilesUnresolved: 0, hostilesNeutralized: 0, civilianLivesLost: 0 });
    expect(report.keyEvents[2].outcome).toContain('survived');
    expect(report.keyEvents[1].outcome).toContain('launched missiles');
    expect(report.autonomyTimeline).toEqual([{ t: 0, domain: 'air', level: 'HOLD' }, { t: 0, domain: 'surface', level: 'HOLD' }]);
    expect(analyze(events, meta)).toEqual(report);
  });
  it('attributes delegated engagements at decision-time, excludes rejections and never invents civil confirmation', () => {
    const events = [event(1, 'autonomy_changed', { domain: 'surface', level: 'WEAPONS_FREE' }, 'player'),
      event(2, 'autonomy_changed', { domain: 'air', level: 'VETO' }, 'player'),
      command(500, 's7', 'doctrine', 'surface', 'WEAPONS_FREE'), fire(500, 's7', 'doctrine', 'gun'), death(510, 's7', 'hostile', 0, 'doctrine'),
      command(700, 'a9', 'ai-auto', 'air', 'VETO', false),
      command(710, 'a9', 'ai-auto', 'air', 'VETO'), fire(710, 'a9', 'ai-auto', 'sam'),
      event(711, 'autonomy_changed', { domain: 'air', level: 'HOLD' }, 'player'),
      death(770, 'a9', 'civil', 212, 'ai-auto'),
      event(771, 'crew-report', { contactId: 'a9', text: 'Splash one', station: 'TAO-Air' }, 'crew-auto')];
    const report = analyze(events, meta);
    expect(report.summary.civilianLivesLost).toBe(212);
    expect(report.summary.hostilesNeutralized).toBe(1);
    expect(report.keyEvents[1].decisions[0]).toMatchObject({ actor: 'doctrine', autonomy: 'WEAPONS_FREE', rangeNm: 6 });
    expect(report.keyEvents[2].decisions).toHaveLength(1);
    expect(report.keyEvents[2].decisions[0]).toMatchObject({ actor: 'ai-auto', autonomy: 'VETO', rangeNm: 38 });
    expect(report.keyEvents[2].information).toEqual([{ t: null, text: 'Civil confirmation was not recorded during this playthrough.' }]);
    expect(report.decisions.some(d => !d.ok && d.error === 'out of range')).toBe(true);
    expect(report.decisions.every(d => d.actor !== 'crew-auto')).toBe(true);
    expect(report.autonomyTimeline.at(-1)).toMatchObject({ domain: 'air', level: 'HOLD' });
  });
  it('handles mixed authority and recorded civil information after the decision', () => {
    const events = [command(500, 's7', 'doctrine', 'surface', 'CONSENT'), fire(500, 's7', 'doctrine', 'gun'), death(510, 's7', 'hostile', 0, 'doctrine'),
      event(780, 'crew-report', { contactId: 'a9', station: 'EW', text: 'commercial weather radar' }, 'scenario')];
    const report = analyze(events, meta);
    expect(report.keyEvents[1].decisions[0].autonomy).toBe('CONSENT');
    expect(report.keyEvents[2].decisions).toEqual([]);
    expect(report.keyEvents[2].information[0].t).toBe(780);
    expect(report.summary.civilianLivesLost).toBe(0);
  });
  it('attributes a manual civilian engagement to the player and calculates relative observed timing', () => {
    const events = [command(700, 'a9', 'player', 'air', 'HOLD'), fire(700, 'a9', 'player', 'sam'),
      event(752, 'crew-report', { contactId: 'a9', station: 'EW', text: 'commercial weather radar' }, 'scenario'), death(760, 'a9', 'civil', 212, 'player')];
    const report = analyze(events, meta);
    expect(report.keyEvents[2].decisions[0]).toMatchObject({ actor: 'player', autonomy: 'HOLD' });
    expect(report.keyEvents[2].information[0]).toMatchObject({ t: 752, text: expect.stringContaining('52.0 seconds after') });
    expect(report.summary.civilianLivesLost).toBe(212);
  });
  it('retains unresolved inbound missiles and a ship-loss verdict at early termination', () => {
    const report = analyze([event(1, 'ascm_launched', { missileId: 'm1' })], { ...meta, endedAtS: 42, hullPct: 0, shipLost: true });
    expect(report.verdict).toBe('Ship lost');
    expect(report.summary.missilesUnresolved).toBe(1);
    expect(report.endedAtS).toBe(42);
  });
});

it('does not count a validated weapon command without a recorded launch as an engagement', () => {
  const report = analyze([command(1, 'a9', 'player', 'air', 'HOLD')], meta);
  expect(report.decisions[0]).toMatchObject({ ok: true, executed: false });
  expect(report.keyEvents[2].decisions).toEqual([]);
  expect(report.engagements).toEqual([]);
});

it('records automatic countermeasures under point-defense policy without attributing them to air authority', () => {
  const report = analyze([
    event(1, 'ascm_launched', { missileId: 'm1' }),
    event(2, 'chaff_deployed', { remaining: 5 }, 'crew-auto'),
    event(3, 'weapon_fired', { weapon: 'ciws', targetId: 'm1', targetTrackId: 'M-01' }, 'crew-auto'),
    event(4, 'point_defense_mode', { mode: 'manual' }, 'player'),
    event(5, 'command', { command: { action: 'chaff' }, ok: true, autonomy: { air: 'HOLD', surface: 'HOLD' } }, 'player'),
    event(5, 'chaff_deployed', { remaining: 4 }, 'player'),
  ], meta);
  expect(report.decisions.filter(d => d.action === 'chaff')).toHaveLength(2);
  expect(report.decisions.find(d => d.actor === 'crew-auto' && d.action === 'chaff')).toMatchObject({ pointDefense: 'auto', autonomy: null, executed: true });
  expect(report.decisions.find(d => d.actor === 'crew-auto' && d.action === 'ciws')).toMatchObject({ pointDefense: 'auto', autonomy: null, executed: true });
  expect(report.decisions.find(d => d.actor === 'player' && d.action === 'chaff')).toMatchObject({ pointDefense: 'manual', executed: true });
});


it('does not blame waiting for visual identification when an early engagement misses', () => {
  const report = analyze([
    command(511, 's7', 'doctrine', 'surface', 'WEAPONS_FREE'),
    fire(511, 's7', 'doctrine', 'gun'),
    event(520, 'weapon_result', { weapon: 'gun', targetId: 's7', killed: false }, 'doctrine'),
    event(618, 'missile-launch', { launcherId: 's7', rangeNm: 4.9 }),
  ], meta);
  expect(report.keyEvents[1].outcome).toContain('launched missiles');
  expect(report.keyEvents[1].lesson).toContain('timely engagement did not guarantee neutralization');
  expect(report.keyEvents[1].lesson).not.toContain('Waiting');
});
