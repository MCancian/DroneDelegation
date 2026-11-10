import type { AutonomyDomain, AutonomyLevel, AutonomyState, Behavior, Domain, GameEvent, IffInfo, PointDefenseMode, SensorInfo, Truth } from './types';
import type { Command } from './commands';
import type { CrewPriority, CrewStation, HostileAct, MissileLaunchRequest } from './scenario/scenario';
import type { Proposal } from '../ai/proposals';

export type AutonomySnapshot = AutonomyState;

export function defaultAutonomySnapshot(): AutonomySnapshot {
  return { air: 'HOLD', surface: 'HOLD' };
}

/** An attempt is not an execution unless ok is true. Snapshot is captured at decision time. */
export type CommandPayload = { command: Command; autonomy: AutonomySnapshot } &
  ({ ok: true; error?: never } | { ok: false; error: string });

export interface CommandResponsePayload {
  action: string;
  target: string;
  trackId: string;
  outcome: 'ignored' | 'complied' | 'answered' | 'iff';
  iff?: IffInfo;
}

export interface CrewReportPayload {
  station: CrewStation;
  priority: CrewPriority;
  text: string;
  contactId?: string;
  trackId?: string;
  triggerId?: string;
}

export interface AutonomyChangePayload {
  domain: AutonomyDomain | 'pointDefense';
  previous: AutonomyLevel | PointDefenseMode;
  level: AutonomyLevel | PointDefenseMode;
  autonomy: AutonomyState & { pointDefense: PointDefenseMode };
}

/** These established spellings and payloads are persisted in the event log. */
export interface EventPayloadMap {
  command: CommandPayload;
  command_response: CommandResponsePayload;
  autonomy_changed: AutonomyChangePayload;
  weapon_fired: { weapon: 'sam' | 'gun' | 'ciws'; targetId: string; targetTrackId: string; rangeNm?: number; salvoId?: string; interceptorIds?: string[]; flightTimeS?: number };
  weapon_result: { weapon: 'sam' | 'gun' | 'ciws'; targetId: string; killed: boolean; salvoId?: string };
  /** Private ground truth. This belongs to simulation and after-action analysis only. */
  contact_destroyed: { contactId: string; trackId: string; domain: Domain; truth: Truth; casualties: number; weapon: string };
  chaff_deployed: { activeUntilS: number; remaining: number };
  point_defense_mode: { mode: PointDefenseMode };
  ascm_launched: { missileId: string; trackId: string; launcherId: string; weapon: string };
  missile_impact: { missileId: string; launcherId: string; hit: boolean; chaffActive: boolean; hullPct: number };
  ship_lost: { hullPct: number };
  'contact-spawn': { contactId: string; trackId: string };
  trigger: { triggerId: string };
  'behavior-change': { contactId: string; triggerId: string; behavior: Behavior['kind'] };
  'sensor-change': { contactId: string; triggerId: string; sensors: Partial<SensorInfo> };
  'crew-report': CrewReportPayload;
  'missile-launch': MissileLaunchRequest & { triggerId: string };
  'hostile-act': HostileAct;
  'scenario-end': { t: number };
  doctrine_match: { rule: 'ROE-3' | 'ROE-5'; target: string; trackId: string; rangeNm: number };
  ai_action_error: { error: string };
  'ai-action-error': { error: string; context: 'chat' };
  proposal_advice: (Proposal & { error?: string }) | { command: Command; reason: string; error: string };
  proposal_failed: (Proposal & { error?: string }) | { command: Command; reason: string; error: string };
  proposal_created: Proposal;
  proposal_approved: Proposal;
  proposal_denied: Proposal;
  proposal_vetoed: Proposal;
  proposal_expired: Proposal & { error?: string };
  proposal_executed: Proposal;
}

export type KnownEventType = keyof EventPayloadMap;
export type EventPayload<K extends KnownEventType> = EventPayloadMap[K];
export type EventFor<K extends KnownEventType> = GameEvent<EventPayload<K>> & { type: K };
export type KnownGameEvent = { [K in KnownEventType]: EventFor<K> }[KnownEventType];

/** Narrow a trusted log event before reading a known payload. */
export function isEventOfType<K extends KnownEventType>(event: GameEvent, type: K): event is EventFor<K> {
  return event.type === type;
}

export type EventListener<K extends KnownEventType> = (event: EventFor<K>) => void;
type AnyListener = (event: GameEvent) => void;

// Custom events have a separate path and must not impersonate a known event.
const knownEventNames = [
  'command', 'command_response', 'autonomy_changed', 'weapon_fired', 'weapon_result',
  'contact_destroyed', 'chaff_deployed', 'point_defense_mode', 'ascm_launched',
  'missile_impact', 'ship_lost', 'contact-spawn', 'trigger', 'behavior-change',
  'sensor-change', 'crew-report', 'missile-launch', 'hostile-act', 'scenario-end',
  'doctrine_match', 'ai_action_error', 'ai-action-error', 'proposal_advice',
  'proposal_failed', 'proposal_created', 'proposal_approved', 'proposal_denied',
  'proposal_vetoed', 'proposal_expired', 'proposal_executed',
] as const satisfies readonly KnownEventType[];
// Keep the runtime guard exhaustive as the payload map grows.
const allKnownEventsListed: Exclude<KnownEventType, typeof knownEventNames[number]> extends never ? true : never = true;
void allKnownEventsListed;
const knownEventTypes: ReadonlySet<string> = new Set(knownEventNames);

export function assertCustomEventType(type: string): void {
  if (knownEventTypes.has(type)) throw new Error(`Known event '${type}' cannot use custom event API`);
}

export class EventBus {
  private readonly listeners = new Map<string, Set<AnyListener>>();

  on<K extends KnownEventType>(type: K, listener: EventListener<K>): () => void {
    return this.addListener(type, listener as AnyListener);
  }

  onCustom(type: string, listener: AnyListener): () => void {
    assertCustomEventType(type);
    return this.addListener(type, listener);
  }

  private addListener(type: string, listener: AnyListener): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    // The map groups listeners by event type; calls to emit use the same key.
    const stored = listener;
    set.add(stored);
    const ref = set;
    return () => { ref.delete(stored); };
  }

  emit<K extends KnownEventType>(event: GameEvent<EventPayload<NoInfer<K>>> & { type: K }): void {
    this.dispatch(event);
  }

  emitCustom(event: GameEvent): void {
    assertCustomEventType(event.type);
    this.dispatch(event);
  }

  private dispatch(event: GameEvent): void {
    const set = this.listeners.get(event.type);
    if (!set) return;
    for (const listener of set) listener(event);
  }
}
