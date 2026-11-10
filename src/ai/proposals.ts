import { commandDomain, decide } from './autonomy';
import { executeCommand, validateCommand, type Command } from '../sim/commands';
import type { AutonomyDomain, AutonomyLevel } from '../sim/types';
import type { World } from '../sim/world';
import { isEventOfType } from '../sim/events';

export type ProposalActor = 'ai-auto' | 'doctrine';
export type ProposalStatus = 'pending' | 'advice' | 'approved' | 'denied' | 'vetoed' | 'expired' | 'executed' | 'failed';
export interface Proposal {
  id: string;
  command: Command;
  actor: ProposalActor;
  reason: string;
  domain: AutonomyDomain | null;
  level: AutonomyLevel;
  createdAt: number;
  expiresAt: number | null;
  status: ProposalStatus;
}

/** Proposal routing has no clock or I/O of its own; the simulation calls update. */
export class ProposalManager {
  private proposals: Proposal[] = [];
  private nextId = 1;
  private eventCursors = new Map<string, number>();

  constructor(readonly world: World, private readonly isEnded: () => boolean = () => false) {}

  list(): Proposal[] { return structuredClone(this.proposals); }

  hasTarget(target: string): boolean {
    return this.proposals.some((p) => 'target' in p.command && p.command.target === target &&
      (p.status === 'pending' || p.status === 'executed' || p.status === 'approved' || p.status === 'denied' || p.status === 'vetoed')) ||
      this.world.events.some((event) => {
        if (!isEventOfType(event, 'command') || !['player', 'ai-chat', 'ai-auto', 'doctrine'].includes(event.actor)) return false;
        const payload = event.payload;
        return payload.ok === true && !!payload.command && 'target' in payload.command &&
          payload.command.target === target && (payload.command.action === 'engage_sam' || payload.command.action === 'engage_gun' || payload.command.action === 'ciws');
      });
  }

  submit(command: Command, actor: ProposalActor, reason = ''): Proposal | null {
    if (this.isEnded()) return null;
    // Autonomous authority is only for engagements; model text may request other actions.
    if (!('target' in command) || !['engage_sam', 'engage_gun', 'ciws'].includes(command.action)) {
      this.world.logEvent('proposal_advice', actor, { command: structuredClone(command), reason, error: 'Autonomous action is not an engagement' });
      return null;
    }
    const domain = commandDomain(this.world, command);
    if (!domain) {
      this.world.logEvent('proposal_failed', actor, { command: structuredClone(command), reason, error: 'Target is not visible' });
      return null;
    }
    if (this.hasTarget(command.target)) return null;
    const validation = validateCommand(this.world, command);
    if (!validation.ok) {
      this.world.logEvent('proposal_failed', actor, { command: structuredClone(command), reason, error: validation.error });
      return null;
    }
    const level = this.world.autonomy[domain];
    const route = decide(level, command);
    const proposal: Proposal = {
      id: String(this.nextId++), command: structuredClone(command), actor, reason, domain, level,
      createdAt: this.world.time,
      expiresAt: route === 'needs_consent' ? this.world.time + 30 : route === 'veto_window' ? this.world.time + 10 : null,
      status: route === 'advise_only' ? 'advice' : 'pending',
    };
    this.proposals.push(proposal);
    this.eventCursors.set(proposal.id, this.world.events.length);
    this.log('created', proposal);
    if (route === 'execute') this.execute(proposal);
    else if (route === 'advise_only') this.log('advice', proposal);
    return structuredClone(proposal);
  }

  update(): void {
    for (const p of this.proposals) {
      if (p.status !== 'pending') continue;
      if (this.isEnded() || !p.domain || this.world.autonomy[p.domain] !== p.level || !commandDomain(this.world, p.command) || this.invalidated(p)) {
        p.status = 'expired'; this.log('expired', p, 'Authority changed, target lost, or scenario ended');
      } else if (p.expiresAt !== null && this.world.time >= p.expiresAt - 1e-9) {
        if (p.level === 'VETO') this.execute(p);
        else { p.status = 'expired'; this.log('expired', p); }
      }
    }
  }

  approve(id: string): void {
    this.update();
    const p = this.proposals.find((item) => item.id === id && item.status === 'pending' && item.level === 'CONSENT');
    if (!p || this.isEnded()) return;
    p.status = 'approved'; this.log('approved', p); this.execute(p);
  }

  deny(id: string): void {
    this.update();
    const p = this.proposals.find((item) => item.id === id && item.status === 'pending' && item.level === 'CONSENT');
    if (p) { p.status = 'denied'; this.log('denied', p); }
  }

  veto(id: string): void {
    this.update();
    const p = this.proposals.find((item) => item.id === id && item.status === 'pending' && item.level === 'VETO');
    if (p) { p.status = 'vetoed'; this.log('vetoed', p); }
  }

  private invalidated(p: Proposal): boolean {
    return this.world.events.slice(this.eventCursors.get(p.id) ?? 0).some((event) => {
      if (isEventOfType(event, 'autonomy_changed')) return event.payload.domain === p.domain;
      if (!isEventOfType(event, 'command') || (event.actor !== 'player' && event.actor !== 'ai-chat')) return false;
      const payload = event.payload;
      return payload.ok === true && !!payload.command && 'target' in payload.command && 'target' in p.command &&
        payload.command.target === p.command.target &&
        (payload.command.action === 'engage_sam' || payload.command.action === 'engage_gun' || payload.command.action === 'ciws');
    });
  }

  private execute(p: Proposal): void {
    if (this.isEnded() || !p.domain || this.world.autonomy[p.domain] !== p.level || commandDomain(this.world, p.command) !== p.domain || this.invalidated(p)) {
      p.status = 'expired'; this.log('expired', p, 'Authority changed, target lost, or scenario ended'); return;
    }
    const result = executeCommand(this.world, p.command, p.actor);
    p.status = result.ok ? 'executed' : 'failed';
    this.log(p.status, p, result.ok ? undefined : result.error);
  }

  private log(action: 'created' | 'advice' | 'approved' | 'denied' | 'vetoed' | 'expired' | 'executed' | 'failed', proposal: Proposal, error?: string): void {
    this.world.logEvent(`proposal_${action}`, proposal.actor, { ...structuredClone(proposal), ...(error ? { error } : {}) });
  }
}
