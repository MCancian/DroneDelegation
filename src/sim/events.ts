import type { GameEvent, IffInfo } from './types';

export interface AutonomySnapshot {
  air: string;
  surface: string;
}

export function defaultAutonomySnapshot(): AutonomySnapshot {
  return { air: 'HOLD', surface: 'HOLD' };
}

export interface CommandPayload {
  command: unknown;
  ok: boolean;
  error?: string;
  autonomy: AutonomySnapshot;
}

export interface CommandResponsePayload {
  action: string;
  target: string;
  trackId: string;
  outcome: 'ignored' | 'complied' | 'answered' | 'iff';
  iff?: IffInfo;
}

export type EventListener = (event: GameEvent) => void;

export class EventBus {
  private readonly listeners = new Map<string, Set<EventListener>>();

  on(type: string, listener: EventListener): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
    const ref = set;
    return () => {
      ref.delete(listener);
    };
  }

  emit(event: GameEvent): void {
    const set = this.listeners.get(event.type);
    if (!set) return;
    for (const listener of set) {
      listener(event);
    }
  }
}
