import type { Actor, AutonomyDomain, AutonomyLevel, GameEvent } from '../sim/types';
import type { Scenario } from '../sim/scenario/scenario';

/** The scenario is private input: only facts derived for this report are returned. */
export interface ScenarioMeta {
  scenario: Scenario;
  seed: number;
  endedAtS: number;
  hullPct: number;
  shipLost: boolean;
}
export interface AarDecision {
  t: number;
  actor: Actor;
  action: string;
  targetId: string | null;
  trackId: string | null;
  domain: AutonomyDomain | null;
  autonomy: AutonomyLevel | null;
  pointDefense: 'auto' | 'manual' | null;
  ok: boolean;
  executed: boolean;
  error: string | null;
  rangeNm: number | null;
}
export interface AarInformation { t: number | null; text: string; }
export interface AarKeyEvent {
  id: string;
  title: string;
  outcome: string;
  decisions: AarDecision[];
  information: AarInformation[];
  lesson: string;
}
export interface AarModel {
  scenarioName: string;
  seed: number;
  endedAtS: number;
  durationS: number;
  verdict: string;
  summary: {
    hullPct: number;
    missilesInbound: number;
    missilesHit: number;
    missilesIntercepted: number;
    missilesMissed: number;
    missilesUnresolved: number;
    hostilesNeutralized: number;
    civilianLivesLost: number;
  };
  keyEvents: AarKeyEvent[];
  autonomyTimeline: { t: number; domain: AutonomyDomain; level: AutonomyLevel }[];
  decisions: AarDecision[];
  engagements: { t: number; domain: AutonomyDomain; trackId: string; actor: Actor }[];
}

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const str = (value: unknown): string | null => typeof value === 'string' ? value : null;
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const level = (value: unknown): AutonomyLevel | null => value === 'HOLD' || value === 'CONSENT' || value === 'VETO' || value === 'WEAPONS_FREE' ? value : null;

/** Recognize affirmative sensor reports, including the previous crew wording. */
function recordsVisualIdentification(payload: Obj): boolean {
  const text = str(payload.text) ?? '';
  if (payload.station === 'Lookouts') {
    return /^(?:Sir, lookouts visually identify a |Lookouts: \S+ identified as )\S/i.test(text);
  }
  // A contact first seen within visual range includes the identification in
  // its initial surface assessment rather than emitting a second report.
  return payload.station === 'SWC' &&
    /^Sir, new surface contact bearing \d{3}\. Lookouts visually identify a \S/i.test(text);
}

/** Pure analysis of recorded events; it does not simulate unobserved information. */
export function analyze(events: readonly GameEvent[], meta: ScenarioMeta): AarModel {
  const contacts = new Map(meta.scenario.contacts.map(c => [c.id, c]));
  const timeline: AarModel['autonomyTimeline'] = [
    { t: 0, domain: 'air', level: 'HOLD' }, { t: 0, domain: 'surface', level: 'HOLD' },
  ];
  const current: Record<AutonomyDomain, AutonomyLevel> = { air: 'HOLD', surface: 'HOLD' };
  const decisions: AarDecision[] = [];
  const engagements: AarModel['engagements'] = [];
  const inbound = new Set<string>();
  const defeated = new Set<string>();
  const resolved = new Set<string>();
  const destroyed = new Set<string>();
  let hits = 0, hostiles = 0, casualties = 0;
  let pointDefense: 'auto' | 'manual' = 'manual';

  for (const event of events) {
    const p = obj(event.payload);
    if (event.type === 'autonomy_changed' && (p.domain === 'air' || p.domain === 'surface')) {
      const next = level(p.level);
      if (next) { current[p.domain] = next; timeline.push({ t: event.t, domain: p.domain, level: next }); }
    }
    if (event.type === 'point_defense_mode' && (p.mode === 'auto' || p.mode === 'manual')) pointDefense = p.mode;
    if (event.type === 'ascm_launched') {
      const id = str(p.missileId); if (id) inbound.add(id);
    }
    if (event.type === 'missile_impact') {
      const id = str(p.missileId);
      if (id && !resolved.has(id)) { resolved.add(id); if (p.hit === true) hits++; }
    }
    if (event.type === 'contact_destroyed') {
      const id = str(p.contactId);
      if (id && !destroyed.has(id)) {
        destroyed.add(id);
        if (p.domain === 'missile') defeated.add(id);
        if (p.truth === 'hostile' && p.domain !== 'missile') hostiles++;
        if (p.truth === 'civil') casualties += num(p.casualties) ?? 0;
      }
    }
    if (event.type === 'command') {
      const command = obj(p.command);
      const action = str(command.action) ?? 'unknown';
      const targetId = str(command.target);
      const contact = targetId ? contacts.get(targetId) : undefined;
      // Missile targets are air-domain for autonomy; scenario metadata contains
      // only initial contacts, so identify spawned missiles from launch events.
      const domain: AutonomyDomain | null = contact?.domain === 'surface' ? 'surface'
        : contact?.domain === 'air' || (targetId !== null && inbound.has(targetId)) ? 'air' : null;
      const snapshot = obj(p.autonomy);
      const decision: AarDecision = {
        t: event.t, actor: event.actor, action, targetId,
        trackId: contact?.trackId ?? null, domain,
        autonomy: domain && action !== 'ciws' ? level(snapshot[domain]) : null,
        pointDefense: ['ciws', 'chaff', 'set_point_defense'].includes(action) ? pointDefense : null,
        ok: p.ok === true, executed: p.ok === true && !['engage_sam', 'engage_gun', 'ciws', 'chaff'].includes(action), error: str(p.error), rangeNm: null,
      };
      decisions.push(decision);
    }
    if (event.type === 'chaff_deployed') {
      const d = [...decisions].reverse().find(x => x.t === event.t && x.actor === event.actor && x.action === 'chaff' && x.ok);
      if (d) d.executed = true;
      else decisions.push({ t: event.t, actor: event.actor, action: 'chaff', targetId: null, trackId: null, domain: null, autonomy: null, pointDefense, ok: true, executed: true, error: null, rangeNm: null });
    }
    if (event.type === 'weapon_fired') {
      const targetId = str(p.targetId);
      const weapon = str(p.weapon);
      const contact = targetId ? contacts.get(targetId) : undefined;
      const domain: AutonomyDomain = contact?.domain === 'surface' ? 'surface' : 'air';
      const trackId = str(p.targetTrackId) ?? contact?.trackId ?? targetId ?? 'unknown';
      engagements.push({ t: event.t, domain, trackId, actor: event.actor });
      // Associate the weapon with its same-tick command, never with a crew narration.
      const action = weapon === 'sam' ? 'engage_sam' : weapon === 'gun' ? 'engage_gun' : weapon;
      const d = [...decisions].reverse().find(x => x.t === event.t && x.actor === event.actor && x.targetId === targetId && x.action === action && x.ok);
      if (d) { d.rangeNm = num(p.rangeNm); d.executed = true; }
      // Automatic point defense has no command; record the deciding actor and
      // policy at fire time, independently of later crew reports.
      else decisions.push({ t: event.t, actor: event.actor, action: weapon ?? 'weapon', targetId, trackId, domain,
        autonomy: weapon === 'ciws' ? null : current[domain], pointDefense: weapon === 'ciws' ? pointDefense : null, ok: true, executed: true, error: null, rangeNm: num(p.rangeNm) });
    }
  }
  // A missed missile also no longer threatens the ship.
  const intercepted = new Set([...defeated].filter(id => inbound.has(id)));
  const missed = new Set<string>();
  for (const event of events) if (event.type === 'missile_impact') {
    const p = obj(event.payload); const id = str(p.missileId);
    if (id && p.hit === false && inbound.has(id)) missed.add(id);
  }
  const unresolved = [...inbound].filter(id => !defeated.has(id) && !resolved.has(id)).length;

  function key(id: string, title: string): AarKeyEvent {
    const selected = decisions.filter(d => d.targetId === id && d.executed && ['engage_sam', 'engage_gun', 'ciws'].includes(d.action));
    const launches = events.filter(e => e.type === 'missile-launch' && obj(e.payload).launcherId === id);
    const dead = destroyed.has(id);
    const target = contacts.get(id);
    const label = target?.trackId ?? title;
    const outcome = id === 'a9' ? (dead ? `${label}, a civilian airliner, was destroyed.` : (target?.spawnAtS ?? 0) > meta.endedAtS ? `${label} had not appeared before the scenario ended.` : `${label}, a civilian airliner, survived.`)
      : dead ? `${label} was neutralized${launches.length ? ' after launching missiles' : ' before a recorded missile launch'}.`
      : launches.length ? `${label} launched missiles and was not neutralized.` : `${label} was not recorded as neutralized or launching missiles.`;
    const information: AarInformation[] = [];
    for (const launch of launches) {
      const range = num(obj(launch.payload).rangeNm);
      information.push({ t: launch.t, text: `Missile launch${range === null ? '' : ` at ${range.toFixed(1)} nm`}.` });
    }
    if (id === 's7') {
      information.push({ t: null, text: 'Visual identification requires 3 nm; the launch threshold is 5 nm.' });
      const visual = events.find(e => e.type === 'crew-report' && obj(e.payload).contactId === id && recordsVisualIdentification(obj(e.payload)));
      information.push(visual ? { t: visual.t, text: str(obj(visual.payload).text) ?? 'Visual identification reported.' } : { t: null, text: 'Visual identification was not recorded.' });
    }
    if (id === 'a9') {
      const civil = events.find(e => e.type === 'crew-report' && obj(e.payload).contactId === id && (/commercial weather[- ]radar|civil[- ]frequency/i.test(str(obj(e.payload).text) ?? '')));
      if (civil) {
        const first = selected[0];
        const relative = first ? ` ${Math.abs(civil.t - first.t).toFixed(1)} seconds ${civil.t >= first.t ? 'after' : 'before'} the first engagement.` : '';
        information.push({ t: civil.t, text: `${str(obj(civil.payload).text) ?? 'Civil confirmation reported.'}${relative}` });
      } else information.push({ t: null, text: 'Civil confirmation was not recorded during this playthrough.' });
    }
    const lesson = id === 'a9' ? (dead ? 'Matching a hostile approach vector did not establish identity; review the authority and timing of the engagement.' : 'No civilian loss occurred for this contact; consider what evidence was available before deciding.')
      : id === 's7' ? (dead && launches.length === 0 ? 'The craft was stopped before a recorded launch; visual identification was available only at shorter range.' : !dead && selected.some(d => launches.some(launch => d.t < launch.t)) ? 'No confirmed neutralization was recorded before the missile launch.' : 'Visual identification was available only at shorter range than the launch threshold.')
      : (launches.length ? 'The first hostile launch established intent and informed later decisions.' : 'Review the timing and information available before the first hostile act.');
    return { id: id === 'a1' ? 'E1' : id === 's7' ? 'E2' : 'E3', title, outcome, decisions: selected.map(d => ({ ...d })), information, lesson };
  }
  return {
    scenarioName: meta.scenario.name, seed: meta.seed, endedAtS: meta.endedAtS, durationS: meta.scenario.durationS,
    verdict: meta.shipLost ? 'Ship lost' : casualties ? 'Transit complete with civilian losses' : 'Transit complete',
    summary: { hullPct: meta.hullPct, missilesInbound: inbound.size, missilesHit: hits,
      missilesIntercepted: intercepted.size, missilesMissed: missed.size,
      missilesUnresolved: unresolved, hostilesNeutralized: hostiles, civilianLivesLost: casualties },
    keyEvents: [key('a1', 'E1 · Strike aircraft'), key('s7', 'E2 · Attack craft'), key('a9', 'E3 · Airliner')],
    autonomyTimeline: timeline, decisions, engagements,
  };
}
