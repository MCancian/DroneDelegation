import type { World } from '../world';
import type { RadarContact, Vec2 } from '../types';
import { bearingTo, rangeTo, cpa, closingSpeed, velocityFrom, angleDiff } from '../geo';
import type { CrewStation, CrewPriority } from './scenario';
import { executeCommand } from '../commands';

export interface CrewReport {
  station: CrewStation;
  priority: CrewPriority;
  text: string;
  contactId?: string;
  trackId?: string;
}

interface SafeSnap {
  id: string; trackId: string; domain: string; position: Vec2;
  courseDeg: number; speedKts: number; altitudeFt: number;
  sensors: RadarContact['sensors']; ownMissile?: boolean;
}

interface MissileAssoc { missileId: string; launcherId: string; }

interface CrewState {
  prev: Map<string, SafeSnap>;
  known: Set<string>;
  eventCursor: number;
  cooldowns: Map<string, number>;
  reportedMissiles: Set<string>;
  missileToLauncher: Map<string, string>;
  pendingHostile: MissileAssoc[];
  knownTrackIds: Map<string, string>;
}

const stateMap = new WeakMap<World, CrewState>();

function getState(world: World): CrewState {
  let s = stateMap.get(world);
  if (!s) {
    s = { prev: new Map(), known: new Set(), eventCursor: 0, cooldowns: new Map(),
      reportedMissiles: new Set(), missileToLauncher: new Map(), pendingHostile: [],
      knownTrackIds: new Map() };
    stateMap.set(world, s);
  }
  return s;
}

function emit(world: World, r: CrewReport): void {
  world.logEvent('crew-report', 'crew-auto', r);
}

function cdOk(st: CrewState, key: string, t: number, cd: number): boolean {
  const last = st.cooldowns.get(key);
  if (last !== undefined && t - last < cd) return false;
  st.cooldowns.set(key, t);
  return true;
}

function snap(t: RadarContact): SafeSnap {
  return { id: t.id, trackId: t.trackId, domain: t.domain,
    position: { x: t.position.x, y: t.position.y },
    courseDeg: t.courseDeg, speedKts: t.speedKts, altitudeFt: t.altitudeFt,
    sensors: structuredClone(t.sensors), ownMissile: t.ownMissile };
}

function defaultSnap(t: RadarContact): SafeSnap {
  return { id: t.id, trackId: t.trackId, domain: t.domain,
    position: { x: t.position.x, y: t.position.y },
    courseDeg: t.courseDeg, speedKts: t.speedKts, altitudeFt: t.altitudeFt,
    sensors: { iff: { kind: 'none' }, ais: { kind: 'none' }, esm: { kind: 'none' }, visual: { kind: 'none' } },
    ownMissile: t.ownMissile };
}

function fmtBrg(b: number): string { return String(Math.round(b) % 360).padStart(3, '0'); }
function fmtRng(r: number): string { return r.toFixed(1); }

function stationForDomain(domain: string): CrewStation {
  return domain === 'surface' ? 'SWC' : 'TAO-Air';
}

function trackLabel(world: World, st: CrewState, contactId: string): string {
  const tr = world.trackFor(contactId);
  if (tr) { st.knownTrackIds.set(contactId, tr.trackId); return tr.trackId; }
  const known = st.knownTrackIds.get(contactId);
  if (known) return known;
  return 'unknown track';
}

function processEvents(world: World, st: CrewState): void {
  const evts = world.events;
  while (st.eventCursor < evts.length) {
    const ev = evts[st.eventCursor]; st.eventCursor++;
    const p = ev.payload as Record<string, unknown>;
    const t = ev.t;

    if (ev.type === 'crew-report') {
      const station = p.station as string;
      const contactId = p.contactId as string | undefined;
      if (station === 'EW' && contactId) st.cooldowns.set(`EW:${contactId}:esm`, t);
      if (station === 'Lookouts' && contactId) st.cooldowns.set(`Lookouts:${contactId}:visEta`, t);
      if (station === 'Radio' && contactId) st.cooldowns.set(`Radio:${contactId}:civil`, t);
      continue;
    }

    if (ev.type === 'ascm_launched') {
      const missileId = (p.missileId as string) ?? '';
      const launcherId = (p.launcherId as string) ?? '';
      if (missileId && launcherId) {
        st.missileToLauncher.set(missileId, launcherId);
        st.pendingHostile.push({ missileId, launcherId });
      }
      continue;
    }

    if (ev.type === 'missile-launch') {
      continue;
    }

    if (ev.type === 'command_response') {
      const action = p.action as string;
      const target = p.target as string;
      const trackId = p.trackId as string;
      const outcome = p.outcome as string;
      const iff = p.iff as RadarContact['sensors']['iff'] | undefined;

      if (action === 'iff_challenge') {
        if (outcome === 'iff' && iff) {
          if (iff.kind === 'mode4') emit(world, { station: 'TAO-Air', priority: 'routine', text: `TAO-Air: ${trackId} Mode 4 valid, friendly.`, contactId: target, trackId });
          else if (iff.kind === 'mode3') emit(world, { station: 'TAO-Air', priority: 'routine', text: `TAO-Air: ${trackId} squawking Mode 3 ${iff.code}.`, contactId: target, trackId });
          else emit(world, { station: 'TAO-Air', priority: 'priority', text: `TAO-Air: ${trackId} no IFF response.`, contactId: target, trackId });
          st.cooldowns.set(`iff:${target}`, t);
        }
      } else if (action === 'radio_warning') {
        if (outcome === 'ignored') emit(world, { station: 'Radio', priority: 'priority', text: `Radio: ${trackId} ignored warning.`, contactId: target, trackId });
        else emit(world, { station: 'Radio', priority: 'routine', text: `Radio: ${trackId} acknowledged warning.`, contactId: target, trackId });
      } else if (action === 'hail') {
        if (outcome === 'ignored') emit(world, { station: 'Radio', priority: 'priority', text: `Radio: ${trackId} ignored hail.`, contactId: target, trackId });
        else emit(world, { station: 'Radio', priority: 'routine', text: `Radio: ${trackId} answered hail.`, contactId: target, trackId });
      } else if (action === 'illuminate') {
        if (outcome === 'ignored') emit(world, { station: 'TAO-Air', priority: 'priority', text: `TAO-Air: ${trackId} ignored illumination.`, contactId: target, trackId });
        else emit(world, { station: 'TAO-Air', priority: 'routine', text: `TAO-Air: ${trackId} turned away from illumination.`, contactId: target, trackId });
      } else if (action === 'warning_shots') {
        if (outcome === 'ignored') emit(world, { station: 'SWC', priority: 'priority', text: `SWC: ${trackId} ignored warning shots.`, contactId: target, trackId });
        else emit(world, { station: 'SWC', priority: 'routine', text: `SWC: ${trackId} complied with warning shots.`, contactId: target, trackId });
      }
      continue;
    }

    if (ev.type === 'weapon_fired') {
      const weapon = p.weapon as string;
      const targetTrackId = p.targetTrackId as string;
      const targetId = p.targetId as string;
      if (weapon === 'sam') emit(world, { station: 'TAO-Air', priority: 'routine', text: `TAO-Air: Birds away, SAM on ${targetTrackId}.`, contactId: targetId, trackId: targetTrackId });
      else if (weapon === 'gun') emit(world, { station: 'SWC', priority: 'routine', text: `SWC: Gun engaged on ${targetTrackId}.`, contactId: targetId, trackId: targetTrackId });
      else if (weapon === 'ciws') emit(world, { station: 'TAO-Air', priority: 'routine', text: `TAO-Air: CIWS engaged on ${targetTrackId}.`, contactId: targetId, trackId: targetTrackId });
      continue;
    }

    if (ev.type === 'weapon_result') {
      const weapon = p.weapon as string;
      const targetId = p.targetId as string;
      const killed = p.killed as boolean;
      const tid = trackLabel(world, st, targetId);
      const station: CrewStation = weapon === 'gun' ? 'SWC' : 'TAO-Air';
      if (killed) emit(world, { station, priority: 'routine', text: `${station}: Splash one, ${tid} destroyed.`, contactId: targetId, trackId: tid });
      else emit(world, { station, priority: 'priority', text: `${station}: Miss on ${tid}.`, contactId: targetId, trackId: tid });
      continue;
    }

    if (ev.type === 'chaff_deployed') {
      emit(world, { station: 'EW', priority: 'routine', text: 'EW: Chaff deployed.' });
      continue;
    }

    if (ev.type === 'missile_impact') {
      const hit = p.hit as boolean;
      const hullPct = p.hullPct as number;
      if (hit) emit(world, { station: 'Bridge', priority: 'flash', text: `Bridge: Missile impact! Hull ${Math.round(hullPct)}%.` });
      else emit(world, { station: 'Bridge', priority: 'routine', text: 'Bridge: Missile missed, no damage.' });
      continue;
    }

    if (ev.type === 'ship_lost') {
      emit(world, { station: 'Bridge', priority: 'flash', text: 'Bridge: Ship lost.' });
      continue;
    }
  }
}

function processTrack(world: World, st: CrewState, track: RadarContact, t: number): void {
  const prev = st.prev.get(track.id) ?? defaultSnap(track);
  const ownPos = world.ownShip.position;
  const rng = rangeTo(ownPos, track.position);
  const brg = bearingTo(ownPos, track.position);
  const firstSeen = !st.known.has(track.id);

  if (firstSeen) {
    st.known.add(track.id);
    st.knownTrackIds.set(track.id, track.trackId);
    if (track.domain === 'air') {
      emit(world, { station: 'CIC', priority: 'routine', text: `CIC: New air track ${track.trackId}, bearing ${fmtBrg(brg)}, range ${fmtRng(rng)} nm, alt ${Math.round(track.altitudeFt)} ft, speed ${Math.round(track.speedKts)} kts.`, contactId: track.id, trackId: track.trackId });
    } else if (track.domain === 'surface') {
      emit(world, { station: 'SWC', priority: 'routine', text: `SWC: New surface track ${track.trackId}, bearing ${fmtBrg(brg)}, range ${fmtRng(rng)} nm, speed ${Math.round(track.speedKts)} kts.`, contactId: track.id, trackId: track.trackId });
    }
  }

  // Speed jump > 10 kts (only if prev existed)
  if (!firstSeen) {
    const speedDelta = Math.abs(track.speedKts - prev.speedKts);
    if (speedDelta > 10) {
      const key = `speed:${track.id}`;
      if (cdOk(st, key, t, 30)) {
        const stn = stationForDomain(track.domain);
        emit(world, { station: stn, priority: 'priority', text: `${stn}: ${track.trackId} speed change ${Math.round(prev.speedKts)} to ${Math.round(track.speedKts)} kts.`, contactId: track.id, trackId: track.trackId });
      }
    }

    // Turn-toward
    const ownBrg = bearingTo(track.position, ownPos);
    const prevErr = Math.abs(angleDiff(prev.courseDeg, ownBrg));
    const nowErr = Math.abs(angleDiff(track.courseDeg, ownBrg));
    const courseChange = Math.abs(angleDiff(prev.courseDeg, track.courseDeg));
    if (prevErr > 45 && nowErr <= 30 && courseChange > 20) {
      const key = `turnToward:${track.id}`;
      if (cdOk(st, key, t, 30)) {
        const stn = stationForDomain(track.domain);
        emit(world, { station: stn, priority: 'priority', text: `${stn}: ${track.trackId} turning toward us, course ${fmtBrg(track.courseDeg)}.`, contactId: track.id, trackId: track.trackId });
      }
    }
  }

  // Closing CPA < 2
  const ownVel = velocityFrom(world.ownShip.courseDeg, world.ownShip.speedKts);
  const tgtVel = velocityFrom(track.courseDeg, track.speedKts);
  const cpaRes = cpa(ownPos, ownVel, track.position, tgtVel);
  const cs = closingSpeed(ownPos, ownVel, track.position, tgtVel);
  if (cpaRes.tCpaSec > 0 && cs > 0 && cpaRes.rangeNm < 2) {
    const key = `cpa:${track.id}`;
    if (cdOk(st, key, t, 30)) {
      const stn = stationForDomain(track.domain);
      emit(world, { station: stn, priority: 'priority', text: `${stn}: ${track.trackId} closing, CPA ${cpaRes.rangeNm.toFixed(1)} nm in ${Math.round(cpaRes.tCpaSec)}s.`, contactId: track.id, trackId: track.trackId });
    }
  }

  // Lookouts visual ETA for fast closing surface track (works first seen)
  if (track.domain === 'surface' && track.speedKts > 30 && track.sensors.ais.kind === 'none'
    && track.sensors.visual.kind === 'none' && cs > 0 && rng > world.sensorConfig.visualRangeNm) {
    const key = `Lookouts:${track.id}:visEta`;
    if (cdOk(st, key, t, 30)) {
      const visR = world.sensorConfig.visualRangeNm;
      const etaSec = (rng - visR) / (cs / 3600);
      if (etaSec > 0) {
        const totalSec = Math.round(etaSec);
        const etaMin = Math.floor(totalSec / 60);
        const etaS = totalSec % 60;
        emit(world, { station: 'Lookouts', priority: 'routine', text: `Lookouts: no visual on ${track.trackId} in haze; est. visual at ${visR} nm in ${etaMin}:${String(etaS).padStart(2, '0')}.`, contactId: track.id, trackId: track.trackId });
      }
    }
  }

  // Sensor info changes (works on first seen via defaultSnap)
  processSensorInfo(world, st, track, prev, t, firstSeen);

  // Classification
  processClassification(world, track);
}

function processSensorInfo(world: World, st: CrewState, track: RadarContact, prev: SafeSnap, t: number, firstSeen: boolean): void {
  const cur = track.sensors;
  const old = prev.sensors;

  // IFF: compare contents
  const iffChanged = cur.iff.kind !== old.iff.kind
    || (cur.iff.kind === 'mode3' && old.iff.kind === 'mode3' && cur.iff.code !== (old.iff as { code: string }).code);
  if (iffChanged && cur.iff.kind !== 'none') {
    const key = `iff:${track.id}`;
    if (cdOk(st, key, t, 5)) {
      if (cur.iff.kind === 'mode4') emit(world, { station: 'TAO-Air', priority: 'routine', text: `TAO-Air: ${track.trackId} Mode 4 valid.`, contactId: track.id, trackId: track.trackId });
      else if (cur.iff.kind === 'mode3') emit(world, { station: 'TAO-Air', priority: 'routine', text: `TAO-Air: ${track.trackId} Mode 3 ${cur.iff.code}.`, contactId: track.id, trackId: track.trackId });
    }
  }

  // AIS: compare contents (name/type may change same kind)
  const aisChanged = cur.ais.kind !== old.ais.kind
    || (cur.ais.kind === 'vessel' && old.ais.kind === 'vessel'
      && (cur.ais.name !== (old.ais as { name: string }).name || cur.ais.vesselType !== (old.ais as { vesselType: string }).vesselType));
  if (aisChanged && cur.ais.kind === 'vessel') {
    const key = `ais:${track.id}`;
    if (cdOk(st, key, t, 30)) {
      emit(world, { station: 'SWC', priority: 'routine', text: `SWC: ${track.trackId} AIS ${cur.ais.name} (${cur.ais.vesselType}).`, contactId: track.id, trackId: track.trackId });
    }
  }

  // ESM: compare emitterType
  const esmChanged = cur.esm.kind !== old.esm.kind
    || (cur.esm.kind === 'emitter' && old.esm.kind === 'emitter' && cur.esm.emitterType !== (old.esm as { emitterType: string }).emitterType);
  if (esmChanged && cur.esm.kind === 'emitter') {
    const key = `EW:${track.id}:esm`;
    if (cdOk(st, key, t, 30)) {
      emit(world, { station: 'EW', priority: 'priority', text: `EW: ${track.trackId} emitting ${cur.esm.emitterType}.`, contactId: track.id, trackId: track.trackId });
    }
  }

  // Visual: compare description
  const visChanged = cur.visual.kind !== old.visual.kind
    || (cur.visual.kind === 'identified' && old.visual.kind === 'identified' && cur.visual.description !== (old.visual as { description: string }).description);
  if (visChanged && cur.visual.kind === 'identified') {
    const key = `visual:${track.id}`;
    if (cdOk(st, key, t, 30)) {
      emit(world, { station: 'Lookouts', priority: 'priority', text: `Lookouts: ${track.trackId} identified as ${cur.visual.description}.`, contactId: track.id, trackId: track.trackId });
    }
  }
}

function processClassification(world: World, track: RadarContact): void {
  if (track.classification !== 'unknown') return;
  if (track.sensors.ais.kind === 'vessel') {
    executeCommand(world, { action: 'classify', target: track.id, classification: 'neutral' }, 'crew-auto');
  } else if (track.sensors.iff.kind === 'mode4') {
    executeCommand(world, { action: 'classify', target: track.id, classification: 'friendly' }, 'crew-auto');
  }
}

function processMissileFlash(world: World, st: CrewState, tracks: RadarContact[], t: number): void {
  const newMissiles: RadarContact[] = [];
  for (const tr of tracks) {
    if (tr.domain !== 'missile' || tr.ownMissile) continue;
    if (st.reportedMissiles.has(tr.id)) continue;
    newMissiles.push(tr);
  }

  if (newMissiles.length > 0) {
    const groups: { bearing: number; tracks: RadarContact[] }[] = [];
    for (const m of newMissiles) {
      const brg = bearingTo(world.ownShip.position, m.position);
      let found = false;
      for (const g of groups) {
        if (Math.abs(angleDiff(g.bearing, brg)) <= 10) { g.tracks.push(m); found = true; break; }
      }
      if (!found) groups.push({ bearing: brg, tracks: [m] });
    }

    for (const g of groups) {
      const count = g.tracks.length;
      const countStr = count === 1 ? 'one' : count === 2 ? 'two' : String(count);
      emit(world, { station: 'TAO-Air', priority: 'flash', text: `TAO-Air: VAMPIRE VAMPIRE, bearing ${fmtBrg(g.bearing)}, ${countStr} missiles inbound.` });
      for (const m of g.tracks) st.reportedMissiles.add(m.id);
    }
  }

  // Process pending hostile associations: only classify launcher whose missile is now visible
  for (let i = st.pendingHostile.length - 1; i >= 0; i--) {
    const assoc = st.pendingHostile[i];
    if (!st.reportedMissiles.has(assoc.missileId)) continue;
    const launcher = world.contactById(assoc.launcherId);
    if (!launcher || !launcher.alive) { st.pendingHostile.splice(i, 1); continue; }
    const launcherTrack = world.trackFor(assoc.launcherId);
    if (!launcherTrack || !launcherTrack.detected) continue;
    if (launcher.classification !== 'hostile') {
      executeCommand(world, { action: 'classify', target: assoc.launcherId, classification: 'hostile' }, 'crew-auto');
    }
    st.pendingHostile.splice(i, 1);
  }
}

export function stepCrew(world: World): void {
  const st = getState(world);
  const tracks = world.visibleTracks();
  const t = world.time;

  processEvents(world, st);

  for (const track of tracks) {
    if (track.ownMissile) continue;
    if (track.domain === 'missile') continue;
    processTrack(world, st, track, t);
  }

  processMissileFlash(world, st, tracks, t);

  for (const track of tracks) {
    st.prev.set(track.id, snap(track));
  }
}
