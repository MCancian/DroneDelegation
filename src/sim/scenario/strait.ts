import type { Vec2 } from '../types';
import { fromBearingRange, move } from '../geo';
import { GAME_DURATION_S } from '../clock';
import type { Scenario } from './scenario';
import { DEFAULT_SENSOR_CONFIG } from '../sensors';
import { WEAPONS_CONFIG } from './weaponsConfig';

export const STRAIT_IDS = {
  a1: 'a1',
  s7: 's7',
  a9: 'a9',
  fastFerry: 'fast-ferry',
} as const;

export const STRAIT_TRIGGERS = {
  a1Launch: 'a1-launch',
  a1TurnAway: 'a1-turn-away',
  s7Sprint: 's7-sprint',
  s7Launch: 's7-launch',
  s7TurnAway: 's7-turn-away',
  a9Iff: 'a9-iff',
  a9Esm: 'a9-esm',
  a9RadioId: 'a9-radio-id',
  a9Turn: 'a9-turn',
} as const;

export const OWN_SHIP_COURSE_DEG = 340;
export const OWN_SHIP_SPEED_KTS = 15;
export const FLEET_ABEAM_T_S = 480;
export const FLEET_ABEAM_BEARING_DEG = 70;
export const FLEET_ABEAM_RANGE_NM = 6.5;

export const FISHING_FLEET_CENTER: Vec2 = fromBearingRange(
  move({ x: 0, y: 0 }, OWN_SHIP_COURSE_DEG, OWN_SHIP_SPEED_KTS, FLEET_ABEAM_T_S),
  FLEET_ABEAM_BEARING_DEG,
  FLEET_ABEAM_RANGE_NM,
);

function abs(x: number, y: number, courseDeg: number) {
  return { kind: 'absolute' as const, position: { x, y }, courseDeg };
}

function fleetOffset(dx: number, dy: number): Vec2 {
  return { x: FISHING_FLEET_CENTER.x + dx, y: FISHING_FLEET_CENTER.y + dy };
}

export const STRAIT_TRANSIT: Scenario = {
  id: 'strait-transit',
  name: 'Strait Transit',
  durationS: GAME_DURATION_S,
  // Missile tracks appear close to impact, leaving a short manual reaction
  // window. Prompt AUTO activation can still engage CIWS and deploy chaff.
  sensorConfig: {
    ...DEFAULT_SENSOR_CONFIG,
    maxRangeNm: { ...DEFAULT_SENSOR_CONFIG.maxRangeNm, missile: 1 },
  },
  // The Strait's multiple missiles threaten the hull without causing an
  // immediate sink; each impact is still visible and consequential.
  weaponsConfig: {
    ...WEAPONS_CONFIG,
    ascm: { ...WEAPONS_CONFIG.ascm, damagePct: 20 },
    ciws: { ...WEAPONS_CONFIG.ciws, pkPerMissile: 0.85 },
  },
  ownShip: {
    position: { x: 0, y: 0 },
    courseDeg: OWN_SHIP_COURSE_DEG,
    speedKts: OWN_SHIP_SPEED_KTS,
    hullPct: 100,
    inventory: { sam: 24, chaff: 6, gunBursts: 40, ciws: 1000 },
  },
  contacts: [
    // ── Air ──────────────────────────────────────────────────────────
    {
      id: 'a1',
      trackId: 'A-01',
      name: 'Red strike aircraft',
      domain: 'air',
      truth: 'hostile',
      placement: { kind: 'fromOwnship', bearingDeg: 45, rangeNm: 60 },
      speedKts: 600,
      altitudeFt: 300,
      spawnAtS: 45,
      behavior: { kind: 'closeOnOwnship', speedKts: 600, mode: 'pure' },
      responses: { radio: 'ignore', illuminate: 'ignore' },
    },
    {
      id: 'air-2',
      trackId: 'A-02',
      name: 'Airliner (airway, eastbound)',
      domain: 'air',
      truth: 'civil',
      placement: abs(-40, 25, 90),
      speedKts: 460,
      altitudeFt: 35000,
      sensors: { iff: { kind: 'mode3', code: '3412' } },
      behavior: { kind: 'straight' },
      responses: { radio: 'comply', illuminate: 'turn-away' },
    },
    {
      id: 'air-3',
      trackId: 'A-03',
      name: 'Airliner (airway, westbound)',
      domain: 'air',
      truth: 'civil',
      placement: abs(50, 25.5, 270),
      speedKts: 470,
      altitudeFt: 37000,
      sensors: { iff: { kind: 'mode3', code: '5521' } },
      behavior: { kind: 'straight' },
      responses: { radio: 'comply', illuminate: 'turn-away' },
    },
    {
      id: 'air-4',
      trackId: 'A-04',
      name: 'Airliner (airway, eastbound)',
      domain: 'air',
      truth: 'civil',
      placement: abs(-5, 24.5, 90),
      speedKts: 450,
      altitudeFt: 33000,
      sensors: { iff: { kind: 'mode3', code: '2203' } },
      behavior: { kind: 'straight' },
      responses: { radio: 'comply', illuminate: 'turn-away' },
    },
    {
      id: 'air-5',
      trackId: 'A-05',
      name: 'Airliner (airway, westbound)',
      domain: 'air',
      truth: 'civil',
      placement: abs(80, 25, 270),
      speedKts: 480,
      altitudeFt: 36000,
      sensors: { iff: { kind: 'mode3', code: '6610' } },
      behavior: { kind: 'straight' },
      responses: { radio: 'comply', illuminate: 'turn-away' },
    },
    {
      id: 'mpa',
      trackId: 'A-06',
      name: 'Friendly maritime patrol aircraft',
      domain: 'air',
      truth: 'friendly',
      classification: 'friendly',
      placement: abs(-8, -45, 90),
      speedKts: 220,
      altitudeFt: 3000,
      sensors: { iff: { kind: 'mode4' } },
      behavior: { kind: 'loiter', center: { x: -8, y: -45 }, radiusNm: 8, speedKts: 220 },
      responses: { iff: { kind: 'mode4' }, radio: 'comply', illuminate: 'ignore' },
    },
    {
      id: 'a9',
      trackId: 'A-09',
      name: 'Civil airliner (Red-registered, delayed departure)',
      domain: 'air',
      truth: 'civil',
      personsAboard: 212,
      placement: { kind: 'fromOwnship', bearingDeg: 45, rangeNm: 60 },
      speedKts: 420,
      altitudeFt: 15000,
      sensors: { iff: { kind: 'mode3', code: '4217' } },
      spawnAtS: 540,
      behavior: { kind: 'straight' },
      responses: { iff: { kind: 'mode3', code: '4217' }, radio: 'comply', radioRangeNm: 28, illuminate: 'ignore' },
    },

    // ── Surface ──────────────────────────────────────────────────────
    {
      id: 'tanker',
      trackId: 'S-01',
      name: 'Tanker',
      domain: 'surface',
      truth: 'civil',
      size: 'ship',
      placement: abs(-4.104, -11.276, 340),
      speedKts: 12,
      altitudeFt: 0,
      sensors: { ais: { kind: 'vessel', name: 'MT GULF PEARL', vesselType: 'tanker' } },
      behavior: { kind: 'straight' },
      responses: { radio: 'comply', hail: 'answer', warningShots: 'turn-away' },
    },
    {
      id: 'container',
      trackId: 'S-02',
      name: 'Container ship',
      domain: 'surface',
      truth: 'civil',
      size: 'ship',
      placement: abs(-6, 14, 160),
      speedKts: 16,
      altitudeFt: 0,
      sensors: { ais: { kind: 'vessel', name: 'MV ORIENT STAR', vesselType: 'container ship' } },
      behavior: { kind: 'straight' },
      responses: { radio: 'comply', hail: 'answer', warningShots: 'turn-away' },
    },
    {
      id: 'ferry',
      trackId: 'S-03',
      name: 'Ferry',
      domain: 'surface',
      truth: 'civil',
      personsAboard: 140,
      size: 'ship',
      placement: abs(2.052, 5.638, 280),
      speedKts: 22,
      altitudeFt: 0,
      sensors: { ais: { kind: 'vessel', name: 'FERRY AL NOOR', vesselType: 'passenger ferry' } },
      behavior: { kind: 'straight' },
      responses: { radio: 'comply', hail: 'answer', warningShots: 'turn-away' },
    },
    {
      id: 'fast-ferry',
      trackId: 'S-04',
      name: 'Fast ferry',
      domain: 'surface',
      truth: 'civil',
      personsAboard: 140,
      size: 'ship',
      placement: abs(-5.196, 3.0, 165),
      speedKts: 25,
      altitudeFt: 0,
      sensors: { ais: { kind: 'vessel', name: 'HSC SEA SWIFT', vesselType: 'high-speed ferry' } },
      behavior: { kind: 'straight' },
      responses: { radio: 'comply', hail: 'answer', warningShots: 'turn-away' },
    },
    {
      id: 'dhow-1',
      trackId: 'S-05',
      name: 'Fishing dhow',
      domain: 'surface',
      truth: 'civil',
      personsAboard: 6,
      size: 'small',
      placement: { kind: 'absolute', position: fleetOffset(-0.8, 0.5), courseDeg: 0 },
      speedKts: 3,
      altitudeFt: 0,
      behavior: { kind: 'loiter', center: FISHING_FLEET_CENTER, radiusNm: 1.5, speedKts: 3 },
      responses: { radio: 'comply', hail: 'ignore', warningShots: 'turn-away' },
    },
    {
      id: 'dhow-2',
      trackId: 'S-06',
      name: 'Fishing dhow',
      domain: 'surface',
      truth: 'civil',
      personsAboard: 6,
      size: 'small',
      placement: { kind: 'absolute', position: fleetOffset(0.6, 0.9), courseDeg: 90 },
      speedKts: 4,
      altitudeFt: 0,
      sensors: { ais: { kind: 'vessel', name: 'AL BAHAR 3', vesselType: 'fishing' } },
      behavior: { kind: 'loiter', center: FISHING_FLEET_CENTER, radiusNm: 1.5, speedKts: 4 },
      responses: { radio: 'comply', hail: 'answer', warningShots: 'turn-away' },
    },
    {
      id: 'dhow-3',
      trackId: 'S-08',
      name: 'Fishing dhow',
      domain: 'surface',
      truth: 'civil',
      personsAboard: 6,
      size: 'small',
      placement: { kind: 'absolute', position: fleetOffset(1.0, -0.6), courseDeg: 180 },
      speedKts: 5,
      altitudeFt: 0,
      behavior: { kind: 'loiter', center: FISHING_FLEET_CENTER, radiusNm: 1.5, speedKts: 5 },
      responses: { radio: 'comply', hail: 'ignore', warningShots: 'turn-away' },
    },
    {
      id: 'dhow-4',
      trackId: 'S-09',
      name: 'Fishing dhow',
      domain: 'surface',
      truth: 'civil',
      personsAboard: 6,
      size: 'small',
      placement: { kind: 'absolute', position: fleetOffset(-0.4, -1.0), courseDeg: 270 },
      speedKts: 6,
      altitudeFt: 0,
      behavior: { kind: 'loiter', center: FISHING_FLEET_CENTER, radiusNm: 1.5, speedKts: 6 },
      responses: { radio: 'comply', hail: 'ignore', warningShots: 'turn-away' },
    },
    {
      id: 'dhow-5',
      trackId: 'S-10',
      name: 'Fishing dhow',
      domain: 'surface',
      truth: 'civil',
      personsAboard: 6,
      size: 'small',
      placement: { kind: 'absolute', position: fleetOffset(0.1, 0.3), courseDeg: 45 },
      speedKts: 3.5,
      altitudeFt: 0,
      behavior: { kind: 'loiter', center: FISHING_FLEET_CENTER, radiusNm: 1.5, speedKts: 3.5 },
      responses: { radio: 'comply', hail: 'ignore', warningShots: 'turn-away' },
    },
    {
      id: 's7',
      trackId: 'S-07',
      name: 'Red low-profile fast attack craft',
      domain: 'surface',
      truth: 'hostile',
      size: 'small',
      rcs: 'low',
      pDetect: 0.6,
      placement: { kind: 'absolute', position: fleetOffset(0.2, -0.2), courseDeg: 0 },
      speedKts: 4,
      altitudeFt: 0,
      behavior: { kind: 'loiter', center: FISHING_FLEET_CENTER, radiusNm: 0.3, speedKts: 4 },
      responses: { radio: 'ignore', hail: 'ignore', warningShots: 'ignore' },
    },
  ],
  triggers: [
    {
      id: 'a1-launch',
      when: { kind: 'rangeBelow', contactId: 'a1', rangeNm: 30 },
      actions: [
        {
          kind: 'launchMissiles',
          contactId: 'a1',
          launch: { count: 2, weapon: 'ASCM', speedKts: 600, altitudeFt: 50 },
        },
      ],
    },
    {
      id: 'a1-turn-away',
      when: { kind: 'hostileAct', byContactId: 'a1' },
      actions: [
        { kind: 'setBehavior', contactId: 'a1', behavior: { kind: 'turnAway', courseDeg: 45, speedKts: 600 } },
      ],
    },
    {
      id: 's7-sprint',
      when: { kind: 'time', atS: 480 },
      actions: [
        { kind: 'setBehavior', contactId: 's7', behavior: { kind: 'closeOnOwnship', speedKts: 40, mode: 'pure', turnRateDegPerSec: 10 } },
        {
          kind: 'crewReport',
          station: 'Lookouts',
          priority: 'routine',
          text: 'Sir, I cannot identify this surface contact through the haze.',
          contactId: 's7',
        },
      ],
    },
    {
      id: 's7-launch',
      when: { kind: 'rangeBelow', contactId: 's7', rangeNm: 5 },
      notBeforeS: 480,
      actions: [
        {
          kind: 'launchMissiles',
          contactId: 's7',
          launch: { count: 2, weapon: 'short-range ASCM', speedKts: 600, altitudeFt: 30 },
        },
      ],
    },
    {
      id: 's7-turn-away',
      when: { kind: 'hostileAct', byContactId: 's7' },
      actions: [
        { kind: 'setBehavior', contactId: 's7', behavior: { kind: 'turnAway', courseDeg: 70, speedKts: 40 } },
      ],
    },
    {
      id: 'a9-iff',
      when: { kind: 'time', atS: 560 },
      actions: [
        {
          kind: 'crewReport',
          station: 'TAO-Air',
          priority: 'priority',
          text: 'Sir, this aircraft is replying, but I cannot correlate it with a flight plan. I cannot establish its identity.',
          contactId: 'a9',
        },
      ],
    },
    {
      id: 'a9-esm',
      when: { kind: 'rangeBelow', contactId: 'a9', rangeNm: 32 },
      actions: [
        {
          kind: 'setSensorInfo',
          contactId: 'a9',
          sensors: { esm: { kind: 'emitter', emitterType: 'commercial weather radar' } },
        },
        {
          kind: 'crewReport',
          station: 'EW',
          priority: 'priority',
          text: 'Sir, commercial weather radar suggests this is a civilian aircraft.',
          contactId: 'a9',
        },
      ],
    },
    {
      id: 'a9-radio-id',
      when: { kind: 'rangeBelow', contactId: 'a9', rangeNm: 28 },
      actions: [
        {
          kind: 'crewReport',
          station: 'Radio',
          priority: 'priority',
          text: 'Sir, a civil-frequency call identifies this aircraft as an airliner joining the airway.',
          contactId: 'a9',
        },
      ],
    },
    {
      id: 'a9-turn',
      when: { kind: 'time', atS: 840 },
      actions: [
        { kind: 'setBehavior', contactId: 'a9', behavior: { kind: 'turnAway', courseDeg: 270, speedKts: 420 } },
      ],
    },
  ],
};
