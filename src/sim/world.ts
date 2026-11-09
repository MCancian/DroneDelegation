import type { Actor, GameEvent, Missile, OwnShip, RadarContact } from './types';
import { move } from './geo';
import { mulberry32, type Rng } from './rng';

export const HISTORY_INTERVAL_S = 30;
export const HISTORY_LENGTH = 6;

export interface WorldInit {
  seed: number;
  ownShip: OwnShip;
  contacts: readonly RadarContact[];
  missiles?: readonly Missile[];
}

export class World {
  time: number = 0;
  readonly seed: number;
  ownShip: OwnShip;
  contacts: RadarContact[];
  missiles: Missile[];
  readonly events: GameEvent[] = [];
  readonly rng: Rng;

  private historyAccS: number = 0;

  constructor(init: WorldInit) {
    this.seed = init.seed;
    this.rng = mulberry32(init.seed);
    this.ownShip = structuredClone(init.ownShip);
    this.contacts = structuredClone(init.contacts) as RadarContact[];
    this.missiles = structuredClone(init.missiles ?? []) as Missile[];
  }

  step(dtS: number): void {
    if (!Number.isFinite(dtS) || dtS <= 0) return;

    this.time += dtS;

    this.ownShip.position = move(
      this.ownShip.position,
      this.ownShip.courseDeg,
      this.ownShip.speedKts,
      dtS,
    );

    for (const contact of this.contacts) {
      if (!contact.alive) continue;
      contact.position = move(
        contact.position,
        contact.courseDeg,
        contact.speedKts,
        dtS,
      );
    }

    for (const missile of this.missiles) {
      if (!missile.alive) continue;
      missile.position = move(
        missile.position,
        missile.courseDeg,
        missile.speedKts,
        dtS,
      );
    }

    this.historyAccS += dtS;
    while (this.historyAccS >= HISTORY_INTERVAL_S - 1e-9) {
      this.historyAccS -= HISTORY_INTERVAL_S;
      for (const contact of this.contacts) {
        if (!contact.alive) continue;
        contact.history.push({ ...contact.position });
        if (contact.history.length > HISTORY_LENGTH) {
          contact.history.splice(0, contact.history.length - HISTORY_LENGTH);
        }
      }
    }
  }

  logEvent<T>(type: string, actor: Actor, payload: T): GameEvent<T> {
    const event: GameEvent<T> = { t: this.time, type, actor, payload };
    this.events.push(event);
    return event;
  }

  contactById(id: string): RadarContact | undefined {
    return this.contacts.find((c) => c.id === id);
  }
}
