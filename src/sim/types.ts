export interface Vec2 {
  x: number;
  y: number;
}

export type Domain = 'air' | 'surface' | 'missile';

export type Classification =
  | 'unknown'
  | 'neutral'
  | 'friendly'
  | 'suspect'
  | 'hostile';

export type Truth = 'civil' | 'hostile' | 'friendly';

export type Actor =
  | 'player'
  | 'ai-chat'
  | 'ai-auto'
  | 'doctrine'
  | 'crew-auto'
  // Actor for events the scenario script itself causes (spawns, enemy launches, scripted crew reports).
  | 'scenario';

export type PointDefenseMode = 'auto' | 'manual';

export type IffInfo =
  | { kind: 'none' }
  | { kind: 'mode3'; code: string }
  | { kind: 'mode4' };

export type AisInfo =
  | { kind: 'none' }
  | { kind: 'vessel'; name: string; vesselType: string };

export type EsmInfo =
  | { kind: 'none' }
  | { kind: 'emitter'; emitterType: string };

export type VisualInfo =
  | { kind: 'none' }
  | { kind: 'identified'; description: string };

export interface SensorInfo {
  iff: IffInfo;
  ais: AisInfo;
  esm: EsmInfo;
  visual: VisualInfo;
}

export type Rcs = 'normal' | 'low';

export type SurfaceSize = 'ship' | 'small';

export interface BehaviorCommon {
  turnRateDegPerSec?: number;
  targetAltitudeFt?: number;
  climbRateFpm?: number;
}

export type Behavior =
  | ({ kind: 'straight'; courseDeg?: number; speedKts?: number } & BehaviorCommon)
  | ({ kind: 'waypoints'; points: Vec2[]; speedKts?: number; arriveRadiusNm?: number } & BehaviorCommon)
  | ({ kind: 'loiter'; center: Vec2; radiusNm: number; speedKts: number; retargetS?: number } & BehaviorCommon)
  | ({ kind: 'closeOnOwnship'; speedKts: number; mode?: 'pure' | 'lead' } & BehaviorCommon)
  | ({ kind: 'turnAway'; courseDeg: number; speedKts?: number } & BehaviorCommon);

export type BehaviorTrigger =
  | { kind: 'time'; atS: number }
  | { kind: 'rangeToOwnshipBelow'; rangeNm: number };

export interface ScheduledBehavior {
  when: BehaviorTrigger;
  behavior: Behavior;
}

export interface MotionState {
  waypointIndex: number;
  waypointsDone: boolean;
  loiterCourseDeg: number;
  loiterTimerS: number;
}

export interface ContactMotion {
  behavior: Behavior;
  schedule?: ScheduledBehavior[];
  state?: MotionState;
}

export interface Contact {
  id: string;
  trackId: string;
  domain: Domain;
  truth: Truth;
  position: Vec2;
  courseDeg: number;
  speedKts: number;
  altitudeFt: number;
  classification: Classification;
  sensors: SensorInfo;
  alive: boolean;
  history: Vec2[];
  rcs?: Rcs;
  size?: SurfaceSize;
  pDetect?: number;
  motion?: ContactMotion;
  personsAboard?: number;
  ownMissile?: boolean;
}

export type RadarContact = Contact & { faded?: boolean };

export interface Missile {
  id: string;
  launcherId: string;
  targetId: string | null;
  position: Vec2;
  courseDeg: number;
  speedKts: number;
  altitudeFt: number;
  alive: boolean;
}

export interface WeaponInventory {
  sam: number;
  chaff: number;
  gunBursts: number;
  ciws: number;
}

export interface OwnShip {
  position: Vec2;
  courseDeg: number;
  speedKts: number;
  hullPct: number;
  inventory: WeaponInventory;
}

export type GameEventType = string;

export interface GameEvent<TPayload = unknown> {
  t: number;
  type: GameEventType;
  actor: Actor;
  payload: TPayload;
}
