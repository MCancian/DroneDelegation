import { describe, expect, it } from 'vitest';
import { analyze, type ScenarioMeta } from '../src/report/analyze';
import { STRAIT_TRANSIT } from '../src/sim/scenario/strait';
import type { Actor, GameEvent } from '../src/sim/types';
import { runScenario } from '../src/sim/scenario/scenario';
import { executeCommand } from '../src/sim/commands';
import { stepCrew } from '../src/sim/scenario/crew';
import { makeContact, makeWorld } from './helpers/sim';

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
  it('retains the actual crew visual identification and its observed time after a player approaches S-7', () => {
    const { world } = runScenario(STRAIT_TRANSIT, 1, {
      untilS: 481,
      onStep(world) {
        if (world.time < 0.2) executeCommand(world, { action: 'maneuver', courseDeg: 70, speedKts: 35 }, 'player');
      },
    });
    const observedAt = world.trackFor('s7')!.visualIdAt;
    expect(observedAt).not.toBeNull();
    const produced = world.events.find(e => e.type === 'crew-report' && e.t === observedAt &&
      (e.payload as { contactId?: string; station?: string }).contactId === 's7' &&
      (e.payload as { station?: string }).station === 'Lookouts');
    expect(produced).toBeDefined();
    const report = analyze(world.events, { ...meta, endedAtS: world.time, hullPct: world.ownShip.hullPct });
    expect(report.keyEvents[1].information).toContainEqual({
      t: observedAt, text: (produced!.payload as { text: string }).text,
    });
    expect(report.keyEvents[1].information.some(info => info.text === 'Visual identification was not recorded.')).toBe(false);
  });
  it('retains a visual identification included in the first sensor-grounded surface assessment', () => {
    const world = makeWorld([makeContact({ id: 's7', trackId: 'S-07', domain: 'surface',
      position: { x: 0, y: 2 }, visualDescription: 'armed fast attack craft' })]);
    stepCrew(world);
    expect(world.visibleTracks()[0].sensors.visual.kind).toBe('identified');
    const produced = world.events.find(e => e.type === 'crew-report')!;
    const report = analyze(world.events, { ...meta, endedAtS: world.time });
    expect(report.keyEvents[1].information).toContainEqual({
      t: produced.t, text: (produced.payload as { text: string }).text,
    });
  });
  it('keeps prior affirmative visual reports while rejecting uncertain and failed identifications', () => {
    const uncertain = [
      event(480, 'crew-report', { contactId: 's7', station: 'Lookouts', text: 'Sir, I cannot identify this surface contact through the haze.' }),
      event(481, 'crew-report', { contactId: 's7', station: 'Lookouts', text: 'Sir, lookouts could not visually identify a vessel.' }),
    ];
    expect(analyze(uncertain, meta).keyEvents[1].information).toContainEqual({
      t: null, text: 'Visual identification was not recorded.',
    });
    const prior = event(482, 'crew-report', { contactId: 's7', station: 'Lookouts', text: 'Lookouts: S-07 identified as armed fast attack craft.' });
    expect(analyze([...uncertain, prior], meta).keyEvents[1].information).toContainEqual({
      t: prior.t, text: (prior.payload as { text: string }).text,
    });
  });
  it('summarizes an all-HOLD playthrough with a hit and no civilian loss', () => {
    const events = [...inbound, event(300, 'missile-launch', { launcherId: 'a1', rangeNm: 29.9 }), event(600, 'missile-launch', { launcherId: 's7', rangeNm: 4.9 })];
    const report = analyze(events, meta);
    expect(report.summary).toEqual({ hullPct: 60, missilesInbound: 2, missilesHit: 1, missilesIntercepted: 1, missilesMissed: 0, missilesUnresolved: 0, hostilesNeutralized: 0, civilianLivesLost: 0 });
    expect(report.keyEvents[2].outcome).toContain('survived');
    expect(report.keyEvents[1].outcome).toContain('launched missiles');
    expect(report.autonomyTimeline).toEqual([{ t: 0, domain: 'air', level: 'HOLD' }, { t: 0, domain: 'surface', level: 'HOLD' }]);
    expect(analyze(events, meta)).toEqual(report);
  });
  it('distinguishes intercepted missiles from misses and hits', () => {
    const report = analyze([
      event(1, 'ascm_launched', { missileId: 'intercepted' }),
      event(2, 'ascm_launched', { missileId: 'missed' }),
      event(3, 'ascm_launched', { missileId: 'hit' }),
      event(4, 'contact_destroyed', { contactId: 'intercepted', domain: 'missile', truth: 'hostile', casualties: 0 }, 'crew-auto'),
      event(5, 'missile_impact', { missileId: 'missed', hit: false, hullPct: 60 }),
      event(6, 'missile_impact', { missileId: 'hit', hit: true, hullPct: 20 }),
    ], meta);
    expect(report.summary).toMatchObject({ missilesInbound: 3, missilesIntercepted: 1, missilesMissed: 1, missilesHit: 1, missilesUnresolved: 0 });
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
    event(0, 'point_defense_mode', { mode: 'auto' }, 'player'),
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


it('does not report a gun miss when engagement destruction is guaranteed', () => {
  const report = analyze([
    command(511, 's7', 'doctrine', 'surface', 'WEAPONS_FREE'),
    fire(511, 's7', 'doctrine', 'gun'),
    event(521, 'weapon_result', { weapon: 'gun', targetId: 's7', killed: true }, 'doctrine'),
    death(521, 's7', 'hostile', 0, 'doctrine'),
  ], meta);
  expect(report.keyEvents[1].outcome).toContain('neutralized before a recorded missile launch');
  expect(report.keyEvents[1].lesson).not.toContain('miss');
  expect(report.keyEvents[1].lesson).not.toContain('did not guarantee neutralization');
});
