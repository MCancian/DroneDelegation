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
  | 'crew-auto';

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
