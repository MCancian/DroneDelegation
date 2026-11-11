import type { World } from '../world';
import type { Domain, SensorTrack, IffInfo, AisInfo, EsmInfo, VisualInfo } from '../types';
import { bearingTo, angleDiff } from '../geo';
import type { CrewStation, CrewPriority } from './scenario';
import { executeCommand } from '../commands';
import { isEventOfType, type CrewRole } from '../events';

export interface CrewReport {
  station: CrewStation;
  priority: CrewPriority;
  text: string;
  domain?: Domain;
  role?: CrewRole;
  contactId?: string;
  trackId?: string;
}

interface MissileAssoc { missileId: string; launcherId: string; }

interface AnnouncedSensors {
  iff: string;
  ais: string;
  esm: string;
  visual: string;
}

interface CrewState {
  known: Set<string>;
  eventCursor: number;
  cooldowns: Map<string, number>;
  reportedMissiles: Set<string>;
  missileToLauncher: Map<string, string>;
  pendingHostile: MissileAssoc[];
  knownTrackIds: Map<string, string>;
  announced: Map<string, AnnouncedSensors>;
  pendingEwReserve: Set<string>;
}

const stateMap = new WeakMap<World, CrewState>();

function getState(world: World): CrewState {
  let s = stateMap.get(world);
  if (!s) {
    s = { known: new Set(), eventCursor: 0, cooldowns: new Map(),
      reportedMissiles: new Set(), missileToLauncher: new Map(), pendingHostile: [],
      knownTrackIds: new Map(), announced: new Map(), pendingEwReserve: new Set() };
    stateMap.set(world, s);
  }
  return s;
}

function emit(world: World, r: CrewReport): void {
  const visible = r.contactId ? world.visibleTracks().find((track) => track.id === r.contactId) : undefined;
  const contactDomain = visible?.domain;
  const domain = r.domain ?? contactDomain;
  const role = r.role ?? (domain === 'air' ? 'air-search' : domain === 'surface' ? 'surface-search' : domain === 'missile' ? 'weapons-officer' :
    r.station === 'CIC' || r.station === 'TAO-Air' || r.station === 'Lookouts' ? 'air-search' :
    r.station === 'SWC' ? 'surface-search' : 'weapons-officer');
  world.logEvent('crew-report', 'crew-auto', { ...r, ...(domain ? { domain } : {}), role });
}

function cdOk(st: CrewState, key: string, t: number, cd: number): boolean {
  const last = st.cooldowns.get(key);
  if (last !== undefined && t - last < cd) return false;
  st.cooldowns.set(key, t);
  return true;
}

function fmtBrg(b: number): string { return String(Math.round(b) % 360).padStart(3, '0'); }

function trackLabel(world: World, st: CrewState, contactId: string): string {
  const tr = world.trackFor(contactId);
  if (tr) { st.knownTrackIds.set(contactId, tr.trackId); return tr.trackId; }
  const known = st.knownTrackIds.get(contactId);
  if (known) return known;
  return 'unknown track';
}

function contactBearing(world: World, contactId: string, _st: CrewState): string {
  const track = world.visibleTracks().find((item) => item.id === contactId);
  return track ? fmtBrg(bearingTo(world.ownShip.position, track.position)) : 'unknown';
}

function initialAssessment(track: SensorTrack): string {
  if (track.sensors.visual.kind === 'identified') {
    return `Lookouts visually identify a ${track.sensors.visual.description}.`;
  }
  if (track.domain === 'air') {
    if (track.sensors.iff.kind === 'mode4') return 'IFF identifies a friendly aircraft.';
    if (track.sensors.esm.kind === 'emitter' && track.sensors.esm.emitterType === 'commercial weather radar') {
      return 'Its emissions are consistent with a civilian airliner.';
    }
    if (track.sensors.iff.kind === 'mode3') return 'It is squawking Mode 3; identity is unconfirmed.';
    if (track.sensors.esm.kind === 'emitter') return `${track.sensors.esm.emitterType} emissions detected; identity is unconfirmed.`;
    return 'I do not know what to make of it yet.';
  }
  if (track.domain === 'surface' && track.sensors.ais.kind === 'vessel') {
    return `AIS reports the vessel type as ${track.sensors.ais.vesselType}; identity is unconfirmed.`;
  }
  if (track.sensors.esm.kind === 'emitter') return `${track.sensors.esm.emitterType} emissions detected; identity is unconfirmed.`;
  return 'I do not know what to make of it yet.';
}

function iffSig(iff: IffInfo): string {
  if (iff.kind === 'none') return 'none';
  if (iff.kind === 'mode3') return `mode3:${iff.code}`;
  return 'mode4';
}
function aisSig(ais: AisInfo): string {
  if (ais.kind === 'none') return 'none';
  return `vessel:${ais.name}:${ais.vesselType}`;
}
function esmSig(esm: EsmInfo): string {
  if (esm.kind === 'none') return 'none';
  return `emitter:${esm.emitterType}`;
}
function visSig(vis: VisualInfo): string {
  if (vis.kind === 'none') return 'none';
  return `identified:${vis.description}`;
}

function getAnnounced(st: CrewState, id: string): AnnouncedSensors {
  let a = st.announced.get(id);
  if (!a) {
    a = { iff: 'none', ais: 'none', esm: 'none', visual: 'none' };
    st.announced.set(id, a);
  }
  return a;
}

function processEvents(world: World, st: CrewState): void {
  const evts = world.events;
  while (st.eventCursor < evts.length) {
    const ev = evts[st.eventCursor]; st.eventCursor++;
    const p = ev.payload as Record<string, unknown>;
    const t = ev.t;

    if (isEventOfType(ev, 'command')) {
      const { command, ok } = ev.payload;
      if (ok && command.action === 'iff_challenge') {
        const trackId = trackLabel(world, st, command.target);
        emit(world, {
          station: 'TAO-Air', priority: 'routine',
          text: `Sir, IFF challenge sent at bearing ${contactBearing(world, command.target, st)}; awaiting response.`,
          contactId: command.target, trackId,
        });
      }
      continue;
    }

    if (ev.type === 'crew-report') {
      const station = p.station as string;
      const contactId = p.contactId as string | undefined;
      if (station === 'Lookouts' && contactId) st.cooldowns.set(`Lookouts:${contactId}:visEta`, t);
      if (station === 'Radio' && contactId) st.cooldowns.set(`Radio:${contactId}:civil`, t);
      if (station === 'EW' && contactId) {
        const contact = world.contactById(contactId);
        if (contact && contact.alive) {
          const track = world.trackFor(contactId);
          if (track && track.detected) {
            const esm = contact.sensors.esm;
            const text = (p.text as string) ?? '';
            if (esm.kind === 'emitter') {
              if (text.includes(esm.emitterType)) {
                const ann = getAnnounced(st, contactId);
                ann.esm = esmSig(esm);
              }
            } else {
              if (text.includes('emitting')) {
                st.pendingEwReserve.add(contactId);
              }
            }
          }
        }
      }
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
      const iff = p.iff as SensorTrack['sensors']['iff'] | undefined;

      if (action === 'iff_challenge') {
        if (outcome === 'iff' && iff) {
          const bearing = contactBearing(world, target, st);
          if (iff.kind === 'mode4') emit(world, { station: 'TAO-Air', priority: 'routine', text: `Sir, IFF verifies a friendly aircraft at bearing ${bearing}.`, contactId: target, trackId });
          else if (iff.kind === 'mode3') emit(world, { station: 'TAO-Air', priority: 'routine', text: `Sir, IFF response received at bearing ${bearing}; identity remains unconfirmed.`, contactId: target, trackId });
          else emit(world, { station: 'TAO-Air', priority: 'priority', text: `Sir, no IFF response from bearing ${bearing}.`, contactId: target, trackId });
          const ann = getAnnounced(st, target);
          ann.iff = iffSig(iff);
        }
      } else if (action === 'radio_warning') {
        const bearing = contactBearing(world, target, st);
        if (outcome === 'ignored') emit(world, { station: 'Radio', priority: 'priority', text: `Sir, the contact at bearing ${bearing} ignored our warning.`, contactId: target, trackId });
        else emit(world, { station: 'Radio', priority: 'routine', text: `Sir, the contact at bearing ${bearing} acknowledged our warning.`, contactId: target, trackId });
      } else if (action === 'hail') {
        const bearing = contactBearing(world, target, st);
        if (outcome === 'ignored') emit(world, { station: 'Radio', priority: 'priority', text: `Sir, no answer from the contact at bearing ${bearing}.`, contactId: target, trackId });
        else emit(world, { station: 'Radio', priority: 'routine', text: `Sir, the contact at bearing ${bearing} answered our hail.`, contactId: target, trackId });
      } else if (action === 'illuminate') {
        const bearing = contactBearing(world, target, st);
        if (outcome === 'ignored') emit(world, { station: 'TAO-Air', priority: 'priority', text: `Sir, the contact at bearing ${bearing} ignored illumination.`, contactId: target, trackId });
        else emit(world, { station: 'TAO-Air', priority: 'routine', text: `Sir, the contact at bearing ${bearing} turned away after illumination.`, contactId: target, trackId });
      } else if (action === 'warning_shots') {
        const bearing = contactBearing(world, target, st);
        if (outcome === 'ignored') emit(world, { station: 'SWC', priority: 'priority', text: `Sir, the contact at bearing ${bearing} ignored warning shots.`, contactId: target, trackId });
        else emit(world, { station: 'SWC', priority: 'routine', text: `Sir, the contact at bearing ${bearing} complied with warning shots.`, contactId: target, trackId });
      }
      continue;
    }

    if (ev.type === 'weapon_fired') {
      const weapon = p.weapon as string;
      const targetTrackId = p.targetTrackId as string;
      const targetId = p.targetId as string;
      if (weapon === 'sam') emit(world, { station: 'TAO-Air', role: 'weapons-officer', priority: 'routine', text: 'Weapons, SAM away.', contactId: targetId, trackId: targetTrackId });
      else if (weapon === 'gun') emit(world, { station: 'SWC', role: 'weapons-officer', priority: 'routine', text: 'Weapons, gun burst underway.', contactId: targetId, trackId: targetTrackId });
      else if (weapon === 'ciws') emit(world, { station: 'TAO-Air', role: 'weapons-officer', priority: 'routine', text: 'Weapons, CIWS firing.', contactId: targetId, trackId: targetTrackId });
      continue;
    }

    if (ev.type === 'weapon_result') {
      const weapon = p.weapon as string;
      const targetId = p.targetId as string;
      const killed = p.killed as boolean;
      const tid = trackLabel(world, st, targetId);
      const station: CrewStation = weapon === 'gun' ? 'SWC' : 'TAO-Air';
      if (killed) emit(world, { station, role: 'weapons-officer', priority: 'routine', text: 'Weapons, target destroyed.', contactId: targetId, trackId: tid });
      else emit(world, { station, role: 'weapons-officer', priority: 'priority', text: 'Weapons, shot missed.', contactId: targetId, trackId: tid });
      continue;
    }

    if (ev.type === 'chaff_deployed') {
      emit(world, { station: 'EW', role: 'weapons-officer', priority: 'routine', text: 'Weapons, chaff deployed.' });
      continue;
    }

    if (ev.type === 'missile_impact') {
      const hit = p.hit as boolean;
      const hullPct = p.hullPct as number;
      if (hit) emit(world, { station: 'Bridge', role: 'weapons-officer', priority: 'flash', text: `Bridge, missile impact! Hull at ${Math.round(hullPct)}%.` });
      else emit(world, { station: 'Bridge', role: 'weapons-officer', priority: 'routine', text: 'Bridge, missile missed; no damage.' });
      continue;
    }

    if (ev.type === 'ship_lost') {
      emit(world, { station: 'Bridge', role: 'weapons-officer', priority: 'flash', text: 'Bridge, ship lost.' });
      continue;
    }
  }
}

function processTrack(world: World, st: CrewState, track: SensorTrack, t: number): void {
  const firstSeen = !st.known.has(track.id);

  if (firstSeen) {
    st.known.add(track.id);
    st.knownTrackIds.set(track.id, track.trackId);
    const announced = getAnnounced(st, track.id);
    announced.iff = iffSig(track.sensors.iff);
    announced.ais = aisSig(track.sensors.ais);
    announced.esm = esmSig(track.sensors.esm);
    announced.visual = visSig(track.sensors.visual);
    if (track.domain === 'air' || track.domain === 'surface') {
      const station: CrewStation = track.domain === 'air' ? 'CIC' : 'SWC';
      const bearing = fmtBrg(bearingTo(world.ownShip.position, track.position));
      emit(world, {
        station,
        priority: 'routine',
        text: `Sir, new ${track.domain} contact bearing ${bearing}. ${initialAssessment(track)}`,
        contactId: track.id,
        trackId: track.trackId,
      });
    }
  }

  processSensorInfo(world, st, track);

  processClassification(world, track);
}

function processSensorInfo(world: World, st: CrewState, track: SensorTrack): void {
  const cur = track.sensors;
  const ann = getAnnounced(st, track.id);

  const curIff = iffSig(cur.iff);
  if (curIff !== ann.iff) {
    if (cur.iff.kind !== 'none') {
      const bearing = fmtBrg(bearingTo(world.ownShip.position, track.position));
      if (cur.iff.kind === 'mode4') emit(world, { station: 'TAO-Air', priority: 'routine', text: `Sir, IFF verifies a friendly aircraft at bearing ${bearing}.`, contactId: track.id, trackId: track.trackId });
      else if (cur.iff.kind === 'mode3' && ann.iff === 'none') emit(world, { station: 'TAO-Air', priority: 'routine', text: `Sir, IFF response received at bearing ${bearing}; identity remains unconfirmed.`, contactId: track.id, trackId: track.trackId });
      ann.iff = curIff;
    } else {
      ann.iff = 'none';
    }
  }

  const curAis = aisSig(cur.ais);
  if (curAis !== ann.ais) {
    if (cur.ais.kind === 'vessel') {
      emit(world, { station: 'SWC', priority: 'routine', text: `Sir, AIS reports the vessel type as ${cur.ais.vesselType}; identity is unconfirmed.`, contactId: track.id, trackId: track.trackId });
      ann.ais = curAis;
    } else {
      ann.ais = 'none';
    }
  }

  const curEsm = esmSig(cur.esm);
  if (curEsm !== ann.esm) {
    if (cur.esm.kind === 'emitter') {
      if (st.pendingEwReserve.has(track.id)) {
        st.pendingEwReserve.delete(track.id);
        ann.esm = curEsm;
      } else {
        const message = cur.esm.emitterType === 'commercial weather radar'
          ? 'Sir, commercial weather radar emissions are consistent with civilian air traffic.'
          : `Sir, ${cur.esm.emitterType} emissions detected; identity is unconfirmed.`;
        emit(world, { station: 'EW', priority: 'priority', text: message, contactId: track.id, trackId: track.trackId });
        ann.esm = curEsm;
      }
    } else {
      ann.esm = 'none';
    }
  }

  const curVis = visSig(cur.visual);
  if (curVis !== ann.visual) {
    if (cur.visual.kind === 'identified') {
      emit(world, { station: 'Lookouts', priority: 'priority', text: `Sir, lookouts visually identify a ${cur.visual.description}.`, contactId: track.id, trackId: track.trackId });
      ann.visual = curVis;
    } else {
      ann.visual = 'none';
    }
  }
}

function processClassification(world: World, track: SensorTrack): void {
  if (track.classification !== 'unknown') return;
  if (track.sensors.ais.kind === 'vessel') {
    executeCommand(world, { action: 'classify', target: track.id, classification: 'neutral' }, 'crew-auto');
  } else if (track.sensors.iff.kind === 'mode4') {
    executeCommand(world, { action: 'classify', target: track.id, classification: 'friendly' }, 'crew-auto');
  }
}

function processMissileFlash(world: World, st: CrewState, tracks: SensorTrack[], t: number): void {
  const newMissiles: SensorTrack[] = [];
  for (const tr of tracks) {
    if (tr.domain !== 'missile' || tr.ownMissile) continue;
    if (st.reportedMissiles.has(tr.id)) continue;
    newMissiles.push(tr);
  }

  if (newMissiles.length > 0) {
    const groups: { bearing: number; tracks: SensorTrack[] }[] = [];
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
      emit(world, { station: 'TAO-Air', role: 'weapons-officer', priority: 'flash', text: `Sir, VAMPIRE VAMPIRE. ${countStr} missile${count === 1 ? '' : 's'} inbound, bearing ${fmtBrg(g.bearing)}.` });
      for (const m of g.tracks) st.reportedMissiles.add(m.id);
    }
  }

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

}
