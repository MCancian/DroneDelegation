import { parseActions } from './actions';
import { streamChat, type ChatMessage } from './client';
import type { ProposalManager } from './proposals';
import { serializeSituation, type ObservedHostileAct } from './situation';
import { SYSTEM_PROMPT } from './systemPrompt';
import { closingSpeed, rangeTo, velocityFrom } from '../sim/geo';
import type { World } from '../sim/world';
import { isEventOfType } from '../sim/events';

export interface TacticalOptions {
  getHostileActs(): readonly ObservedHostileAct[];
  onReply(text: string): void;
  onNotice?(text: string): void;
  isEnded?(): boolean;
  request?(messages: readonly ChatMessage[], signal: AbortSignal): Promise<string>;
}
interface TrackTrigger { closing: boolean; sam: boolean; gun: boolean; ciws: boolean; missile: boolean }

async function defaultRequest(messages: readonly ChatMessage[], signal: AbortSignal): Promise<string> {
  let reply = '';
  await streamChat(messages, (delta) => { reply += delta; }, signal);
  return reply;
}

/** Schedules tactical requests by simulation time and visible observations. */
export class TacticalLoop {
  private readonly request: NonNullable<TacticalOptions['request']>;
  private tracks = new Map<string, TrackTrigger>();
  private hostileActs = new Set<string>();
  private lastRequestAt = -Infinity;
  private inFlight: AbortController | null = null;
  private pending = false;
  private stopped = false;
  private authority = '';
  private authorityEventCursor = 0;

  constructor(readonly world: World, private readonly manager: ProposalManager, private readonly options: TacticalOptions) {
    this.request = options.request ?? defaultRequest;
  }

  update(): void {
    if (this.stopped || this.options.isEnded?.()) { this.stop(); return; }
    const isActive = this.world.autonomy.air !== 'HOLD' || this.world.autonomy.surface !== 'HOLD';
    const authority = `${this.world.autonomy.air}:${this.world.autonomy.surface}`;
    let triggered = isActive && (authority !== this.authority || this.changedAuthoritySince(this.authorityEventCursor));
    this.authority = authority;
    this.authorityEventCursor = this.world.events.length;
    const nextTracks = new Map<string, TrackTrigger>();
    const own = this.world.ownShip;
    const ownVelocity = velocityFrom(own.courseDeg, own.speedKts);
    for (const track of this.world.visibleTracks()) {
      if (!track.alive || track.ownMissile) continue;
      const range = rangeTo(own.position, track.position);
      const config = this.world.weapons.config;
      const current: TrackTrigger = {
        closing: closingSpeed(own.position, ownVelocity, track.position, velocityFrom(track.courseDeg, track.speedKts)) > 0,
        sam: track.domain !== 'surface' && range >= config.sam.minRangeNm && range <= config.sam.maxRangeNm,
        gun: track.domain === 'surface' && range <= config.gun.maxRangeNm,
        ciws: track.domain === 'missile' && range <= config.ciws.maxRangeNm,
        missile: track.domain === 'missile',
      };
      const previous = this.tracks.get(track.id);
      if ((!previous && (current.closing || current.missile || current.sam || current.gun || current.ciws)) ||
          (previous && ((!previous.closing && current.closing) || (!previous.sam && current.sam) ||
            (!previous.gun && current.gun) || (!previous.ciws && current.ciws)))) triggered = true;
      nextTracks.set(track.id, current);
    }
    this.tracks = nextTracks;
    for (const act of this.options.getHostileActs()) {
      const key = `${act.trackId}:${act.t}`;
      if (!this.hostileActs.has(key)) { this.hostileActs.add(key); triggered = true; }
    }
    if (!isActive) {
      this.pending = false;
      this.inFlight?.abort();
      return;
    }
    if (triggered || this.world.time - this.lastRequestAt >= 20 - 1e-9) this.pending = true;
    if (this.inFlight || !this.pending) return;
    this.pending = false;
    this.startRequest();
  }

  stop(): void {
    this.stopped = true;
    this.pending = false;
    this.inFlight?.abort();
  }

  private changedAuthoritySince(cursor: number): boolean {
    return this.world.events.slice(cursor).some((event) => isEventOfType(event, 'autonomy_changed') &&
      (event.payload.domain === 'air' || event.payload.domain === 'surface'));
  }

  private startRequest(): void {
    const startedAt = this.world.time;
    this.lastRequestAt = startedAt;
    const eventCursor = this.world.events.length;
    const levels = { ...this.world.autonomy };
    const controller = new AbortController();
    this.inFlight = controller;
    const instruction = `You hold Air ${levels.air} and Surface ${levels.surface} authority. Decide whether to act now; output action blocks for engagements you judge necessary under ROE.`;
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: serializeSituation(this.world, this.options.getHostileActs()) },
      { role: 'user', content: instruction },
    ];
    void Promise.resolve().then(() => this.request(messages, controller.signal)).then((reply) => {
      if (controller.signal.aborted || this.stopped || this.options.isEnded?.()) return;
      if (this.world.autonomy.air !== levels.air || this.world.autonomy.surface !== levels.surface || this.changedAuthoritySince(eventCursor)) {
        // The old snapshot cannot act under new authority. Reassess it as soon
        // as this request settles, including changes between simulation steps.
        this.pending = true;
        return;
      }
      if (this.world.time - startedAt > 30 + 1e-9) return;
      this.options.onReply(reply);
      const parsed = parseActions(reply, this.world);
      for (const error of parsed.errors) {
        this.world.logEvent('ai_action_error', 'ai-auto', { error });
        this.options.onNotice?.(error);
      }
      for (const command of parsed.commands) this.manager.submit(command, 'ai-auto');
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && !this.stopped) this.options.onNotice?.(`Tactical assistant unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      if (this.inFlight === controller) this.inFlight = null;
      if (this.pending && !this.stopped) this.update();
    });
  }
}
