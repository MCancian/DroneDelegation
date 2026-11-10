import type { Contact, Domain, OwnShip, RadarContact, Vec2, VisualInfo } from './types';
import { move, rangeTo } from './geo';
import type { Rng } from './rng';

export interface SensorConfig {
  sweepPeriodS: number;
  pDetectLowRcs: number;
  maxRangeNm: { air: number; ship: number; smallCraft: number; missile: number };
  visualRangeNm: number;
  dropAfterS: number;
}

export const DEFAULT_SENSOR_CONFIG: SensorConfig = {
  sweepPeriodS: 4,
  pDetectLowRcs: 0.6,
  maxRangeNm: { air: 90, ship: 20, smallCraft: 9, missile: 30 },
  visualRangeNm: 3,
  dropAfterS: 60,
};

export const TRACK_HISTORY_INTERVAL_S = 30;
export const TRACK_HISTORY_LENGTH = 6;

export interface TrackState {
  contactId: string;
  trackId: string;
  detected: boolean;
  firstDetectedAt: number;
  lastSeen: number;
  lastPosition: Vec2;
  lastCourseDeg: number;
  lastSpeedKts: number;
  lastAltitudeFt: number;
  faded: boolean;
  history: Vec2[];
  lastHistoryAt: number;
  visual: VisualInfo;
  visualIdAt: number | null;
}

export interface SensorState {
  tracks: Record<string, TrackState>;
  nextTrackNumber: Record<'A' | 'S' | 'M', number>;
  lastSweepAt: number | null;
}

export function createSensorState(): SensorState {
  return {
    tracks: {},
    nextTrackNumber: { A: 1, S: 1, M: 1 },
    lastSweepAt: null,
  };
}

export function detectionRangeNm(contact: Contact, cfg: SensorConfig = DEFAULT_SENSOR_CONFIG): number {
  switch (contact.domain) {
    case 'air':
      return cfg.maxRangeNm.air;
    case 'missile':
      return cfg.maxRangeNm.missile;
    case 'surface':
      return contact.size === 'small' ? cfg.maxRangeNm.smallCraft : cfg.maxRangeNm.ship;
  }
}

export function inVisualRange(ownShip: OwnShip, contact: Contact, cfg: SensorConfig = DEFAULT_SENSOR_CONFIG): boolean {
  return rangeTo(ownShip.position, contact.position) <= cfg.visualRangeNm;
}

export function visualDescriptionFor(contact: Contact): string {
  if (contact.visualDescription !== undefined && contact.visualDescription !== '') {
    return contact.visualDescription;
  }
  switch (contact.domain) {
    case 'air':
      return 'Aircraft';
    case 'surface':
      return contact.size === 'small' ? 'Small craft' : 'Vessel';
    case 'missile':
      return 'Missile';
  }
}

export function canVisuallyIdentify(
  contact: Contact,
  ownShip: OwnShip,
  cfg: SensorConfig = DEFAULT_SENSOR_CONFIG,
): boolean {
  return (
    contact.alive &&
    !contact.ownMissile &&
    contact.domain !== 'missile' &&
    inVisualRange(ownShip, contact, cfg)
  );
}

export function trackPrefix(domain: Domain): 'A' | 'S' | 'M' {
  switch (domain) {
    case 'air':
      return 'A';
    case 'surface':
      return 'S';
    case 'missile':
      return 'M';
  }
}

export function isDetectedOnSweep(
  contact: Contact,
  ownShip: OwnShip,
  rng: Rng,
  cfg: SensorConfig = DEFAULT_SENSOR_CONFIG,
): boolean {
  if (!contact.alive) return false;
  if (contact.ownMissile) return true;
  const range = rangeTo(ownShip.position, contact.position);
  if (range > detectionRangeNm(contact, cfg)) return false;
  if (range <= cfg.visualRangeNm) return true;
  if (contact.rcs === 'low') {
    return rng.chance(contact.pDetect ?? cfg.pDetectLowRcs);
  }
  return true;
}

function isTrackIdUsed(state: SensorState, trackId: string): boolean {
  for (const track of Object.values(state.tracks)) {
    if (track.trackId === trackId) return true;
  }
  return false;
}

function assignTrackId(state: SensorState, contact: Contact): string {
  const prefix = trackPrefix(contact.domain);
  if (contact.trackId && !isTrackIdUsed(state, contact.trackId)) {
    return contact.trackId;
  }
  let n = state.nextTrackNumber[prefix];
  let candidate = `${prefix}-${String(n).padStart(2, '0')}`;
  while (isTrackIdUsed(state, candidate)) {
    n++;
    candidate = `${prefix}-${String(n).padStart(2, '0')}`;
  }
  state.nextTrackNumber[prefix] = n + 1;
  return candidate;
}

function copyVec(v: Vec2): Vec2 {
  return { x: v.x, y: v.y };
}

export function sweep(
  state: SensorState,
  contacts: readonly Contact[],
  ownShip: OwnShip,
  timeS: number,
  rng: Rng,
  cfg: SensorConfig = DEFAULT_SENSOR_CONFIG,
): void {
  for (const contact of contacts) {
    const hit = isDetectedOnSweep(contact, ownShip, rng, cfg);
    const track = state.tracks[contact.id];

    if (hit) {
      if (!track) {
        const trackId = assignTrackId(state, contact);
        state.tracks[contact.id] = {
          contactId: contact.id,
          trackId,
          detected: true,
          firstDetectedAt: timeS,
          lastSeen: timeS,
          lastPosition: copyVec(contact.position),
          lastCourseDeg: contact.courseDeg,
          lastSpeedKts: contact.speedKts,
          lastAltitudeFt: contact.altitudeFt,
          faded: false,
          history: [],
          lastHistoryAt: -Infinity,
          visual: { kind: 'none' },
          visualIdAt: null,
        };
        const newTrack = state.tracks[contact.id];
        newTrack.history.push(copyVec(contact.position));
        newTrack.lastHistoryAt = timeS;
      } else {
        track.detected = true;
        track.faded = false;
        track.lastSeen = timeS;
        track.lastPosition = copyVec(contact.position);
        track.lastCourseDeg = contact.courseDeg;
        track.lastSpeedKts = contact.speedKts;
        track.lastAltitudeFt = contact.altitudeFt;
        if (timeS - track.lastHistoryAt >= TRACK_HISTORY_INTERVAL_S - 1e-9) {
          track.history.push(copyVec(contact.position));
          if (track.history.length > TRACK_HISTORY_LENGTH) {
            track.history = track.history.slice(-TRACK_HISTORY_LENGTH);
          }
          track.lastHistoryAt = timeS;
        }
      }

      // Visual ID latch: once identified, stays identified.
      const t = state.tracks[contact.id];
      if (t.visual.kind === 'none' && canVisuallyIdentify(contact, ownShip, cfg)) {
        t.visual = { kind: 'identified', description: visualDescriptionFor(contact) };
        t.visualIdAt = timeS;
      }
    } else if (track) {
      if (!contact.alive) {
        track.detected = false;
      } else if (track.detected) {
        track.faded = true;
        if (timeS - track.lastSeen > cfg.dropAfterS) {
          track.detected = false;
        }
      }
    }
  }

  state.lastSweepAt = timeS;
}

export function displayedPosition(track: TrackState, timeS: number): Vec2 {
  return move(track.lastPosition, track.lastCourseDeg, track.lastSpeedKts, timeS - track.lastSeen);
}

export function visibleTracks(
  state: SensorState,
  contacts: readonly Contact[],
  timeS: number,
): RadarContact[] {
  const result: RadarContact[] = [];
  for (const contact of contacts) {
    if (!contact.alive) continue;
    const track = state.tracks[contact.id];
    if (!track || !track.detected) continue;

    const clone = structuredClone(contact) as RadarContact;
    clone.trackId = track.trackId;
    clone.position = displayedPosition(track, timeS);
    clone.courseDeg = track.lastCourseDeg;
    clone.speedKts = track.lastSpeedKts;
    clone.altitudeFt = track.lastAltitudeFt;
    clone.history = track.history.map(copyVec);
    clone.faded = track.faded;
    delete clone.motion;
    delete clone.visualDescription;
    delete clone.responses;
    if (track.visual.kind === 'identified') {
      clone.sensors.visual = { ...track.visual };
    }
    result.push(clone);
  }
  return result;
}
