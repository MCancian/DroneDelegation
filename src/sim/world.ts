import type { Actor, AutonomyState, GameEvent, Missile, OwnShip, RadarContact, SensorTrack } from './types';
import { move } from './geo';
import { mulberry32, type Rng } from './rng';
import { stepKinematics } from './kinematics';
import {
  createSensorState,
  sweep,
  visibleTracks as sensorVisibleTracks,
  DEFAULT_SENSOR_CONFIG,
  type SensorConfig,
  type SensorState,
  type TrackState,
} from './sensors';
import { createWeaponsState, stepWeapons, type WeaponsState } from './weapons';
import type { WeaponsConfig } from './scenario/weaponsConfig';
import { stepCommands } from './commands';
import { EventBus } from './events';

export const HISTORY_INTERVAL_S = 30;
export const HISTORY_LENGTH = 6;

export interface WorldInit {
  seed: number;
  ownShip: OwnShip;
  contacts: readonly RadarContact[];
  missiles?: readonly Missile[];
  sensorConfig?: SensorConfig;
  weaponsConfig?: WeaponsConfig;
}

export class World {
  time: number = 0;
  readonly seed: number;
  ownShip: OwnShip;
  contacts: RadarContact[];
  missiles: Missile[];
  readonly events: GameEvent[] = [];
  readonly eventBus = new EventBus();
  readonly rng: Rng;
  readonly sensorConfig: SensorConfig;
  readonly sensors: SensorState;
  readonly weapons: WeaponsState;
  readonly autonomy: AutonomyState = { air: 'HOLD', surface: 'HOLD' };

  private readonly kinematicsRng: Rng;
  private readonly sensorRng: Rng;
  private sweepAccS: number = 0;
  private historyAccS: number = 0;

  constructor(init: WorldInit) {
    this.seed = init.seed;
    this.rng = mulberry32(init.seed);
    this.kinematicsRng = mulberry32((init.seed ^ 0x9e3779b9) >>> 0);
    this.sensorRng = mulberry32((init.seed ^ 0x85ebca6b) >>> 0);
    this.sensorConfig = init.sensorConfig ?? DEFAULT_SENSOR_CONFIG;
    this.sensors = createSensorState();
    this.weapons = createWeaponsState(init.seed, init.weaponsConfig);
    this.ownShip = structuredClone(init.ownShip);
    this.contacts = structuredClone(init.contacts) as RadarContact[];
    this.missiles = structuredClone(init.missiles ?? []) as Missile[];

    sweep(this.sensors, this.contacts, this.ownShip, 0, this.sensorRng, this.sensorConfig);
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
      stepKinematics(contact, this.ownShip, this.time, dtS, this.kinematicsRng);
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

    stepWeapons(this, dtS);

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

    this.sweepAccS += dtS;
    while (this.sweepAccS >= this.sensorConfig.sweepPeriodS - 1e-9) {
      this.sweepAccS -= this.sensorConfig.sweepPeriodS;
      sweep(this.sensors, this.contacts, this.ownShip, this.time, this.sensorRng, this.sensorConfig);
    }

    stepCommands(this);
  }

  /**
   * Sensor-facing projection. Only legitimate observed/estimated state is
   * exposed; ground-truth fields are structurally absent from the return type.
   */
  visibleTracks(): SensorTrack[] {
    return sensorVisibleTracks(this.sensors, this.contacts, this.time);
  }

  trackFor(contactId: string): TrackState | undefined {
    return this.sensors.tracks[contactId];
  }

  logEvent<T>(type: string, actor: Actor, payload: T): GameEvent<T> {
    const event: GameEvent<T> = { t: this.time, type, actor, payload };
    this.events.push(event);
    this.eventBus.emit(event);
    return event;
  }

  contactById(id: string): RadarContact | undefined {
    return this.contacts.find((c) => c.id === id);
  }
}
