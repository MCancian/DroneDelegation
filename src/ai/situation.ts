import type { World } from '../sim/world';
import { bearingTo, rangeTo, cpa, closingSpeed, velocityFrom } from '../sim/geo';

export interface ObservedHostileAct {
  trackId: string;
  t: number;
  altitudeFt: number;
  speedKts: number;
  bearingDeg: number;
  rangeNm: number;
}

interface TrackSnapshot {
  trackId: string;
  position: { x: number; y: number };
  courseDeg: number;
  speedKts: number;
  altitudeFt: number;
  time: number;
  ownPosition: { x: number; y: number };
}

interface PendingAssoc {
  missileId: string;
  launcherId: string;
  launcherTrackId: string;
  profile: TrackSnapshot;
}

interface ConfirmedAct {
  trackId: string;
  t: number;
  altitudeFt: number;
  speedKts: number;
  bearingDeg: number;
  rangeNm: number;
}

export class SituationHistory {
  private snapshots: Map<string, TrackSnapshot> = new Map();
  private eventCursor: number = 0;
  private pending: PendingAssoc[] = [];
  private confirmed: ConfirmedAct[] = [];
  private confirmedKeys: Set<string> = new Set();

  observe(world: World): void {
    const tracks = world.visibleTracks();
    const newSnapshots = new Map<string, TrackSnapshot>();
    const detectedMissiles = new Set<string>();

    for (const t of tracks) {
      newSnapshots.set(t.id, {
        trackId: t.trackId,
        position: { x: t.position.x, y: t.position.y },
        courseDeg: t.courseDeg,
        speedKts: t.speedKts,
        altitudeFt: t.altitudeFt,
        time: world.time,
        ownPosition: { x: world.ownShip.position.x, y: world.ownShip.position.y },
      });
      if (t.domain === 'missile' && !t.ownMissile) {
        detectedMissiles.add(t.id);
      }
    }

    const events = world.events;
    while (this.eventCursor < events.length) {
      const ev = events[this.eventCursor];
      this.eventCursor++;
      if (ev.type === 'ascm_launched') {
        const p = ev.payload as Record<string, unknown>;
        const missileId = (p.missileId as string) ?? '';
        const launcherId = (p.launcherId as string) ?? '';
        if (missileId && launcherId) {
          const snap = this.snapshots.get(launcherId);
          if (snap) {
            this.pending.push({
              missileId,
              launcherId,
              launcherTrackId: snap.trackId,
              profile: { ...snap, time: ev.t },
            });
          }
        }
      }
    }

    for (let i = this.pending.length - 1; i >= 0; i--) {
      const assoc = this.pending[i];
      if (!detectedMissiles.has(assoc.missileId)) continue;
      const launcherSnap = newSnapshots.get(assoc.launcherId);
      if (!launcherSnap) continue;
      const key = `${assoc.launcherTrackId}:${assoc.profile.time}`;
      if (this.confirmedKeys.has(key)) {
        this.pending.splice(i, 1);
        continue;
      }
      const brg = bearingTo(assoc.profile.ownPosition, assoc.profile.position);
      const rng = rangeTo(assoc.profile.ownPosition, assoc.profile.position);
      this.confirmed.push({
        trackId: assoc.launcherTrackId,
        t: assoc.profile.time,
        altitudeFt: assoc.profile.altitudeFt,
        speedKts: assoc.profile.speedKts,
        bearingDeg: brg,
        rangeNm: rng,
      });
      this.confirmedKeys.add(key);
      this.pending.splice(i, 1);
    }

    this.snapshots = newSnapshots;
  }

  acts(): ObservedHostileAct[] {
    return this.confirmed.map((a) => ({ ...a }));
  }
}

function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `T+${m}:${String(s).padStart(2, '0')}`;
}

function fmtBrg(b: number): string {
  return String(Math.round(b) % 360).padStart(3, '0');
}

export function serializeSituation(
  world: World,
  hostileActs: readonly ObservedHostileAct[] = [],
): string {
  const lines: string[] = [];
  const own = world.ownShip;

  lines.push(`TIME: ${fmtTime(world.time)} (${world.time.toFixed(0)}s)`);
  lines.push(`OWN: pos(${own.position.x.toFixed(1)},${own.position.y.toFixed(1)}) course ${Math.round(own.courseDeg)} spd ${Math.round(own.speedKts)}kt hull ${Math.round(own.hullPct)}%`);
  lines.push(`INV: SAM ${own.inventory.sam} chaff ${own.inventory.chaff} gun ${own.inventory.gunBursts} CIWS ${own.inventory.ciws}`);
  lines.push(`PD: ${world.weapons.pointDefense}`);
  lines.push(`AIR ${world.autonomy.air} | SURFACE ${world.autonomy.surface}`);
  lines.push('');
  lines.push('TRACKS:');

  const tracks = world.visibleTracks();
  const ownVel = velocityFrom(own.courseDeg, own.speedKts);

  for (const t of tracks) {
    const rng = rangeTo(own.position, t.position);
    const brg = bearingTo(own.position, t.position);
    const tgtVel = velocityFrom(t.courseDeg, t.speedKts);
    const cpaRes = cpa(own.position, ownVel, t.position, tgtVel);
    const cs = closingSpeed(own.position, ownVel, t.position, tgtVel);
    const closing = cs > 0 ? 'CLOSING' : 'OPENING';
    const age = world.time - (world.trackFor(t.id)?.firstDetectedAt ?? world.time);
    const faded = t.faded ? ' FADED' : '';

    const parts: string[] = [
      `${t.trackId} ${t.domain} ${t.classification}`,
      `brg ${fmtBrg(brg)} rng ${rng.toFixed(1)}nm`,
      `crs ${Math.round(t.courseDeg)} spd ${Math.round(t.speedKts)}kt`,
    ];
    if (t.domain === 'air' || t.domain === 'missile') {
      parts.push(`alt ${Math.round(t.altitudeFt)}ft`);
    }
    parts.push(closing, `CPA ${cpaRes.rangeNm.toFixed(1)}nm/${Math.round(cpaRes.tCpaSec)}s`);
    parts.push(`age ${Math.round(age)}s${faded}`);

    if (t.sensors.iff.kind === 'mode3') parts.push(`IFF M3:${t.sensors.iff.code}`);
    else if (t.sensors.iff.kind === 'mode4') parts.push('IFF M4');
    if (t.sensors.ais.kind === 'vessel') parts.push(`AIS ${t.sensors.ais.name}(${t.sensors.ais.vesselType})`);
    if (t.sensors.esm.kind === 'emitter') parts.push(`ESM ${t.sensors.esm.emitterType}`);
    if (t.sensors.visual.kind === 'identified') parts.push(`VIS ${t.sensors.visual.description}`);

    lines.push('  ' + parts.join(' | '));
  }

  const crewReports = world.events.filter((e) => e.type === 'crew-report');
  const last10 = crewReports.slice(-10);
  if (last10.length > 0) {
    lines.push('');
    lines.push('CREW:');
    for (const ev of last10) {
      const p = ev.payload as Record<string, unknown>;
      const station = (p.station as string) ?? '';
      const text = (p.text as string) ?? '';
      lines.push(`  [${fmtTime(ev.t)}] ${station}: ${text}`);
    }
  }

  if (hostileActs.length > 0) {
    lines.push('');
    lines.push('HOSTILE ACTS:');
    for (const act of hostileActs) {
      lines.push(
        `  ${act.trackId} launched at ${fmtTime(act.t)} from ${act.rangeNm.toFixed(0)}nm brg ${fmtBrg(act.bearingDeg)}; profile ${Math.round(act.altitudeFt)}ft/${Math.round(act.speedKts)}kt`,
      );
    }
  }

  return lines.join('\n');
}
