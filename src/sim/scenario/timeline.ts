import type { Scenario, ScenarioHooks } from './scenario';
import { runScenario } from './scenario';
import { bearingTo, rangeTo } from '../geo';
import type { World } from '../world';
import type { ScenarioRunner } from './scenario';
import { STRAIT_TRIGGERS, STRAIT_IDS } from './strait';

export interface TimelineMark {
  t: number;
  rangeNm: number;
  bearingDeg: number;
}

export interface DetectionMark extends TimelineMark {
  altitudeFt: number;
  speedKts: number;
}

export interface ScenarioTimeline {
  seed: number;
  a1: { detected: DetectionMark | null; launch: TimelineMark | null; turnAway: TimelineMark | null };
  s7: { sprint: TimelineMark | null; launch: TimelineMark | null; minRangeBeforeLaunchNm: number; visualRangeNm: number };
  a9: {
    detected: DetectionMark | null;
    enterSamRange: TimelineMark | null;
    esmReport: TimelineMark | null;
    radioId: TimelineMark | null;
    turn: TimelineMark | null;
    aliveAtEnd: boolean;
  };
  missileLaunches: { launcherId: string; t: number; rangeNm: number; count: number }[];
}

export const SAM_MAX_RANGE_NM = 40;

const TRIGGER_TO_MARK: Record<string, string> = {
  [STRAIT_TRIGGERS.a1Launch]: 'a1.launch',
  [STRAIT_TRIGGERS.a1TurnAway]: 'a1.turnAway',
  [STRAIT_TRIGGERS.s7Sprint]: 's7.sprint',
  [STRAIT_TRIGGERS.s7Launch]: 's7.launch',
  [STRAIT_TRIGGERS.a9Esm]: 'a9.esmReport',
  [STRAIT_TRIGGERS.a9RadioId]: 'a9.radioId',
  [STRAIT_TRIGGERS.a9Turn]: 'a9.turn',
};

const TRIGGER_CONTACT: Record<string, string> = {
  [STRAIT_TRIGGERS.a1Launch]: STRAIT_IDS.a1,
  [STRAIT_TRIGGERS.a1TurnAway]: STRAIT_IDS.a1,
  [STRAIT_TRIGGERS.s7Sprint]: STRAIT_IDS.s7,
  [STRAIT_TRIGGERS.s7Launch]: STRAIT_IDS.s7,
  [STRAIT_TRIGGERS.a9Esm]: STRAIT_IDS.a9,
  [STRAIT_TRIGGERS.a9RadioId]: STRAIT_IDS.a9,
  [STRAIT_TRIGGERS.a9Turn]: STRAIT_IDS.a9,
};

function markFromContact(world: World, contactId: string): TimelineMark {
  const c = world.contactById(contactId);
  if (!c) return { t: world.time, rangeNm: 0, bearingDeg: 0 };
  return {
    t: world.time,
    rangeNm: rangeTo(world.ownShip.position, c.position),
    bearingDeg: bearingTo(world.ownShip.position, c.position),
  };
}

function detectionFromContact(world: World, contactId: string): DetectionMark | null {
  const c = world.contactById(contactId);
  if (!c) return null;
  return {
    t: world.time,
    rangeNm: rangeTo(world.ownShip.position, c.position),
    bearingDeg: bearingTo(world.ownShip.position, c.position),
    altitudeFt: c.altitudeFt,
    speedKts: c.speedKts,
  };
}

function setMark(tl: ScenarioTimeline, path: string, mark: TimelineMark): void {
  switch (path) {
    case 'a1.launch': tl.a1.launch = mark; break;
    case 'a1.turnAway': tl.a1.turnAway = mark; break;
    case 's7.sprint': tl.s7.sprint = mark; break;
    case 's7.launch': tl.s7.launch = mark; break;
    case 'a9.esmReport': tl.a9.esmReport = mark; break;
    case 'a9.radioId': tl.a9.radioId = mark; break;
    case 'a9.turn': tl.a9.turn = mark; break;
  }
}

export function computeTimeline(
  scenario: Scenario,
  seed: number,
  hooks?: ScenarioHooks,
): ScenarioTimeline {
  const tl: ScenarioTimeline = {
    seed,
    a1: { detected: null, launch: null, turnAway: null },
    s7: { sprint: null, launch: null, minRangeBeforeLaunchNm: Infinity, visualRangeNm: 0 },
    a9: { detected: null, enterSamRange: null, esmReport: null, radioId: null, turn: null, aliveAtEnd: false },
    missileLaunches: [],
  };

  let eventIndex = 0;

  const { world } = runScenario(scenario, seed, {
    hooks,
    onStep: (w: World, _r: ScenarioRunner) => {
      // Detection marks
      if (!tl.a1.detected && w.trackFor(STRAIT_IDS.a1)?.detected) {
        tl.a1.detected = detectionFromContact(w, STRAIT_IDS.a1);
      }
      if (!tl.a9.detected && w.trackFor(STRAIT_IDS.a9)?.detected) {
        tl.a9.detected = detectionFromContact(w, STRAIT_IDS.a9);
      }

      // Scan new events
      while (eventIndex < w.events.length) {
        const ev = w.events[eventIndex];
        eventIndex++;

        if (ev.type === 'trigger') {
          const payload = ev.payload as { triggerId: string };
          const path = TRIGGER_TO_MARK[payload.triggerId];
          if (path) {
            const contactId = TRIGGER_CONTACT[payload.triggerId];
            setMark(tl, path, markFromContact(w, contactId));
          }
        }

        if (ev.type === 'missile-launch') {
          const p = ev.payload as { launcherId: string; t: number; rangeNm: number; count: number };
          tl.missileLaunches.push({
            launcherId: p.launcherId,
            t: p.t,
            rangeNm: p.rangeNm,
            count: p.count,
          });
        }
      }

      // A-9 enter SAM range
      if (!tl.a9.enterSamRange) {
        const a9 = w.contactById(STRAIT_IDS.a9);
        if (a9) {
          const r = rangeTo(w.ownShip.position, a9.position);
          if (r < SAM_MAX_RANGE_NM) {
            tl.a9.enterSamRange = {
              t: w.time,
              rangeNm: r,
              bearingDeg: bearingTo(w.ownShip.position, a9.position),
            };
          }
        }
      }

      // S-7 min range before launch
      if (!tl.s7.launch) {
        const s7 = w.contactById(STRAIT_IDS.s7);
        if (s7) {
          const r = rangeTo(w.ownShip.position, s7.position);
          if (r < tl.s7.minRangeBeforeLaunchNm) {
            tl.s7.minRangeBeforeLaunchNm = r;
          }
        }
      }
    },
  });

  tl.s7.visualRangeNm = world.sensorConfig.visualRangeNm;
  const a9 = world.contactById(STRAIT_IDS.a9);
  tl.a9.aliveAtEnd = a9 !== undefined && a9.alive;

  return tl;
}

export function formatGameTime(tS: number): string {
  const totalSec = Math.floor(tS);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `T+${min}:${String(sec).padStart(2, '0')}`;
}

function fmtRange(r: number): string {
  return r.toFixed(1);
}

function fmtBrg(b: number): string {
  return String(Math.round(b)).padStart(3, '0');
}

export function formatTimeline(tl: ScenarioTimeline): string {
  const entries: { t: number; text: string }[] = [];

  if (tl.a1.detected) {
    const d = tl.a1.detected;
    entries.push({
      t: d.t,
      text: `${formatGameTime(d.t)}  A-1  detected  ${fmtRange(d.rangeNm)} nm  brg ${fmtBrg(d.bearingDeg)}  alt ${d.altitudeFt} ft  spd ${d.speedKts} kts`,
    });
  }
  if (tl.a1.launch) {
    const m = tl.a1.launch;
    entries.push({
      t: m.t,
      text: `${formatGameTime(m.t)}  A-1  launches 2 ASCM  ${fmtRange(m.rangeNm)} nm  brg ${fmtBrg(m.bearingDeg)}`,
    });
  }
  if (tl.a1.turnAway) {
    const m = tl.a1.turnAway;
    entries.push({
      t: m.t,
      text: `${formatGameTime(m.t)}  A-1  turns away  ${fmtRange(m.rangeNm)} nm  brg ${fmtBrg(m.bearingDeg)}`,
    });
  }
  if (tl.s7.sprint) {
    const m = tl.s7.sprint;
    entries.push({
      t: m.t,
      text: `${formatGameTime(m.t)}  S-7  sprints  ${fmtRange(m.rangeNm)} nm  brg ${fmtBrg(m.bearingDeg)}`,
    });
  }
  if (tl.s7.launch) {
    const m = tl.s7.launch;
    entries.push({
      t: m.t,
      text: `${formatGameTime(m.t)}  S-7  launches 2 ASCM  ${fmtRange(m.rangeNm)} nm  brg ${fmtBrg(m.bearingDeg)}  (visual ID range ${tl.s7.visualRangeNm.toFixed(1)} nm)`,
    });
  }
  if (tl.a9.detected) {
    const d = tl.a9.detected;
    entries.push({
      t: d.t,
      text: `${formatGameTime(d.t)}  A-9  detected  ${fmtRange(d.rangeNm)} nm  brg ${fmtBrg(d.bearingDeg)}  alt ${d.altitudeFt} ft  spd ${d.speedKts} kts`,
    });
  }
  if (tl.a9.enterSamRange) {
    const m = tl.a9.enterSamRange;
    entries.push({
      t: m.t,
      text: `${formatGameTime(m.t)}  A-9  enters SAM range  ${fmtRange(m.rangeNm)} nm  brg ${fmtBrg(m.bearingDeg)}`,
    });
  }
  if (tl.a9.esmReport) {
    const m = tl.a9.esmReport;
    entries.push({
      t: m.t,
      text: `${formatGameTime(m.t)}  A-9  ESM report  ${fmtRange(m.rangeNm)} nm  brg ${fmtBrg(m.bearingDeg)}`,
    });
  }
  if (tl.a9.radioId) {
    const m = tl.a9.radioId;
    entries.push({
      t: m.t,
      text: `${formatGameTime(m.t)}  A-9  radio ID  ${fmtRange(m.rangeNm)} nm  brg ${fmtBrg(m.bearingDeg)}`,
    });
  }
  if (tl.a9.turn) {
    const m = tl.a9.turn;
    entries.push({
      t: m.t,
      text: `${formatGameTime(m.t)}  A-9  turns west  ${fmtRange(m.rangeNm)} nm  brg ${fmtBrg(m.bearingDeg)}`,
    });
  }

  entries.sort((a, b) => a.t - b.t);

  const lines: string[] = [`Strait Transit timeline (seed ${tl.seed})`];
  for (const e of entries) {
    lines.push(e.text);
  }
  lines.push(`A-9 alive at end: ${tl.a9.aliveAtEnd ? 'yes' : 'no'}`);

  return lines.join('\n');
}
