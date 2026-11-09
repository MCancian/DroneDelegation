import type {
  Classification,
  Contact,
  Domain,
  OwnShip,
  SensorInfo,
  Truth,
  Vec2,
} from '../sim/types';
import { fromBearingRange, move, normalizeDeg } from '../sim/geo';

export type RadarContact = Contact & { faded?: boolean };

export const DEMO_OWN_SHIP: OwnShip = {
  position: { x: 0, y: 0 },
  courseDeg: 340,
  speedKts: 15,
  hullPct: 100,
  inventory: {
    sam: 24,
    chaff: 6,
    gunBursts: 40,
    ciws: 1000,
  },
};

function defaultSensors(): SensorInfo {
  return {
    iff: { kind: 'none' },
    ais: { kind: 'none' },
    esm: { kind: 'none' },
    visual: { kind: 'none' },
  };
}

interface ContactSeed {
  id: string;
  trackId: string;
  domain: Domain;
  truth: Truth;
  position: Vec2;
  courseDeg: number;
  speedKts: number;
  altitudeFt: number;
  classification: Classification;
  sensors?: SensorInfo;
  faded?: boolean;
}

function historyBehind(
  position: Vec2,
  courseDeg: number,
  speedKts: number,
): Vec2[] {
  const backCourse = normalizeDeg(courseDeg + 180);
  const points: Vec2[] = [];
  let p = position;

  for (let i = 0; i < 6; i += 1) {
    p = move(p, backCourse, speedKts, 30);
    points.push(p);
  }

  return points.reverse();
}

function makeContact(seed: ContactSeed): RadarContact {
  const { sensors, faded, ...rest } = seed;

  const contact: RadarContact = {
    ...rest,
    alive: true,
    sensors: sensors ?? defaultSensors(),
    history: historyBehind(seed.position, seed.courseDeg, seed.speedKts),
  };

  if (faded !== undefined) {
    contact.faded = faded;
  }

  return contact;
}

function atBearingRange(bearingDeg: number, rangeNm: number): Vec2 {
  return fromBearingRange(DEMO_OWN_SHIP.position, bearingDeg, rangeNm);
}

export const DEMO_CONTACTS: RadarContact[] = [
  makeContact({
    id: 'A-01',
    trackId: 'A-01',
    domain: 'air',
    truth: 'hostile',
    position: atBearingRange(20, 55),
    courseDeg: 200,
    speedKts: 420,
    altitudeFt: 15000,
    classification: 'unknown',
  }),
  makeContact({
    id: 'A-02',
    trackId: 'A-02',
    domain: 'air',
    truth: 'civil',
    position: atBearingRange(0, 75),
    courseDeg: 90,
    speedKts: 460,
    altitudeFt: 35000,
    classification: 'neutral',
    sensors: {
      ...defaultSensors(),
      iff: { kind: 'mode3', code: '4521' },
    },
  }),
  makeContact({
    id: 'A-03',
    trackId: 'A-03',
    domain: 'air',
    truth: 'civil',
    position: atBearingRange(0, 65),
    courseDeg: 90,
    speedKts: 455,
    altitudeFt: 33000,
    classification: 'neutral',
    sensors: {
      ...defaultSensors(),
      iff: { kind: 'mode3', code: '2163' },
    },
  }),
  makeContact({
    id: 'A-04',
    trackId: 'A-04',
    domain: 'air',
    truth: 'friendly',
    position: atBearingRange(180, 50),
    courseDeg: 0,
    speedKts: 300,
    altitudeFt: 20000,
    classification: 'friendly',
    sensors: {
      ...defaultSensors(),
      iff: { kind: 'mode4' },
    },
  }),
  makeContact({
    id: 'A-05',
    trackId: 'A-05',
    domain: 'air',
    truth: 'hostile',
    position: atBearingRange(45, 45),
    courseDeg: 225,
    speedKts: 400,
    altitudeFt: 15000,
    classification: 'suspect',
    sensors: {
      ...defaultSensors(),
      esm: { kind: 'emitter', emitterType: 'search radar' },
    },
  }),
  makeContact({
    id: 'A-06',
    trackId: 'A-06',
    domain: 'air',
    truth: 'hostile',
    position: atBearingRange(45, 30),
    courseDeg: 225,
    speedKts: 420,
    altitudeFt: 15000,
    classification: 'hostile',
    sensors: {
      ...defaultSensors(),
      esm: { kind: 'emitter', emitterType: 'fire-control radar' },
    },
  }),
  makeContact({
    id: 'S-01',
    trackId: 'S-01',
    domain: 'surface',
    truth: 'civil',
    position: atBearingRange(120, 75),
    courseDeg: 300,
    speedKts: 14,
    altitudeFt: 0,
    classification: 'neutral',
    sensors: {
      ...defaultSensors(),
      ais: {
        kind: 'vessel',
        name: 'MV Coral Trader',
        vesselType: 'tanker',
      },
    },
  }),
  makeContact({
    id: 'S-02',
    trackId: 'S-02',
    domain: 'surface',
    truth: 'civil',
    position: atBearingRange(80, 18),
    courseDeg: 260,
    speedKts: 22,
    altitudeFt: 0,
    classification: 'neutral',
    sensors: {
      ...defaultSensors(),
      ais: {
        kind: 'vessel',
        name: 'MV Strait Ferry',
        vesselType: 'passenger ferry',
      },
    },
  }),
  makeContact({
    id: 'S-03',
    trackId: 'S-03',
    domain: 'surface',
    truth: 'civil',
    position: atBearingRange(100, 8),
    courseDeg: 45,
    speedKts: 5,
    altitudeFt: 0,
    classification: 'unknown',
  }),
  makeContact({
    id: 'S-04',
    trackId: 'S-04',
    domain: 'surface',
    truth: 'hostile',
    position: atBearingRange(70, 5),
    courseDeg: 340,
    speedKts: 40,
    altitudeFt: 0,
    classification: 'hostile',
    faded: true,
  }),
  makeContact({
    id: 'M-01',
    trackId: 'M-01',
    domain: 'missile',
    truth: 'hostile',
    position: atBearingRange(45, 12),
    courseDeg: 225,
    speedKts: 600,
    altitudeFt: 50,
    classification: 'hostile',
  }),
  makeContact({
    id: 'M-02',
    trackId: 'M-02',
    domain: 'missile',
    truth: 'hostile',
    position: atBearingRange(70, 20),
    courseDeg: 250,
    speedKts: 550,
    altitudeFt: 50,
    classification: 'suspect',
  }),
];
