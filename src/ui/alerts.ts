import { closingSpeed, rangeTo, velocityFrom } from '../sim/geo';
import type { OwnShip, SensorTrack } from '../sim/types';

/** ETA is a sensor estimate based on current radial closing speed, not hidden missile truth. */
export function missileThreats(ship: OwnShip, tracks: readonly SensorTrack[]): { count: number; etaS: number | null } {
  let count = 0;
  let etaS: number | null = null;
  const ownVel = velocityFrom(ship.courseDeg, ship.speedKts);
  for (const track of tracks) {
    if (!track.alive || track.domain !== 'missile' || track.ownMissile || track.classification !== 'hostile') continue;
    count++;
    const closing = closingSpeed(ship.position, ownVel, track.position, velocityFrom(track.courseDeg, track.speedKts));
    if (closing > 0) {
      const estimate = rangeTo(ship.position, track.position) * 3600 / closing;
      if (etaS === null || estimate < etaS) etaS = estimate;
    }
  }
  return { count, etaS };
}

export function formatMissileThreat(count: number, etaS: number | null): string {
  if (!count) return 'Missiles: none';
  if (etaS === null || !Number.isFinite(etaS)) return `Missiles: ${count} · ETA unavailable`;
  const seconds = Math.max(0, Math.ceil(etaS));
  return `Missiles: ${count} · ETA ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
