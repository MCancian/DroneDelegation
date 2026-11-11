/** Headless player strategies use the production simulation, sensor view and doctrine. */
import { setAutonomy } from '../ai/autonomy';
import { Doctrine } from '../ai/doctrine';
import { ProposalManager } from '../ai/proposals';
import { SituationHistory } from '../ai/situation';
import { STEP_S } from './clock';
import { executeCommand } from './commands';
import { isEventOfType } from './events';
import { rangeTo } from './geo';
import { loadScenario } from './scenario/scenario';
import { STRAIT_IDS, STRAIT_TRANSIT } from './scenario/strait';

export const STRATEGIES = ['hold', 'free', 'careful', 'slow'] as const;
export type Strategy = typeof STRATEGIES[number];

export interface PlaytestResult {
  seed: number;
  strategy: Strategy;
  endedAtS: number;
  hullPct: number;
  shipLost: boolean;
  s7LaunchedAtS: number | null;
  s7VisualAtS: number | null;
  s7EngagedAtS: number | null;
  s7Stopped: boolean;
  a1LaunchedAtS: number | null;
  a1EngagedAtS: number | null;
  a1Stopped: boolean;
  a1MissilesLaunched: number;
  a1MissilesHit: number;
  a1MissilesIntercepted: number;
  a1MissilesMissed: number;
  a1MissilesUnresolved: number;
  a9EngagedAtS: number | null;
  a9ShotDown: boolean;
  a9Spawned: boolean;
}

/** Runs with a silent LLM: only deterministic doctrine submits autonomous actions.
 * A run stops when the ship is lost, exactly as in the interactive game.
 * Scripted players act using visible tracks and never inspect hidden truth.
 */
export function runPlaytest(strategy: Strategy, seed: number): PlaytestResult {
  const { world, runner } = loadScenario(STRAIT_TRANSIT, seed);
  if (strategy === 'free') setAutonomy(world, 'air', 'WEAPONS_FREE');
  if (strategy === 'free' || strategy === 'careful') setAutonomy(world, 'surface', 'WEAPONS_FREE');
  const proposals = new ProposalManager(world, () => world.weapons.shipLost);
  const history = new SituationHistory();
  const doctrine = new Doctrine(world, proposals, { getHostileActs: () => history.acts() });
  history.observe(world);
  let a1Attempted = false;
  let s7Attempted = false;
  let pointDefenseActivated = false;
  let s7VisualAtS: number | null = null;
  for (let step = 0; step < Math.round(STRAIT_TRANSIT.durationS / STEP_S); step++) {
    world.step(STEP_S);
    runner.update();
    history.observe(world);
    if (world.weapons.shipLost) break;
    proposals.update();
    doctrine.update();
    const tracks = (strategy === 'careful' || strategy === 'slow') ? world.visibleTracks() : [];
    // An ideal careful player reacts promptly to the sensor warning. MANUAL
    // is the default, so surviving missiles requires an explicit decision.
    if (strategy === 'careful' && !pointDefenseActivated &&
        tracks.some(track => track.alive && track.domain === 'missile' && !track.ownMissile)) {
      pointDefenseActivated = executeCommand(world, { action: 'set_point_defense', mode: 'auto' }, 'player').ok;
      executeCommand(world, { action: 'chaff' }, 'player');
    }
    const s7 = tracks.find(t => t.id === STRAIT_IDS.s7 && t.alive);
    if (s7?.sensors.visual.kind === 'identified') {
      s7VisualAtS ??= world.time;
      if (strategy === 'slow' && !s7Attempted) {
        s7Attempted = executeCommand(world, { action: 'engage_gun', target: s7.id }, 'player').ok;
      }
    }
    if (strategy === 'careful' && !a1Attempted) {
      const a1 = tracks.find(t => t.id === STRAIT_IDS.a1 && t.alive);
      if (a1 && rangeTo(world.ownShip.position, a1.position) <= world.weapons.config.sam.maxRangeNm) {
        a1Attempted = executeCommand(world, { action: 'engage_sam', target: a1.id }, 'player').ok;
      }
    }
  }
  const events = world.events;
  const launched = (id: string) => events.find(e => isEventOfType(e, 'missile-launch') && e.payload.launcherId === id)?.t ?? null;
  const engaged = (id: string) => events.find(e => isEventOfType(e, 'weapon_fired') && e.payload.targetId === id)?.t ?? null;
  const stopped = (id: string) => events.some(e => isEventOfType(e, 'contact_destroyed') && e.payload.contactId === id);
  const a1Missiles = events.filter(e => isEventOfType(e, 'ascm_launched') && e.payload.launcherId === STRAIT_IDS.a1);
  const a1Impacts = events.filter(e => isEventOfType(e, 'missile_impact') && e.payload.launcherId === STRAIT_IDS.a1);
  const a1Intercepted = a1Missiles.filter(e => isEventOfType(e, 'ascm_launched') && events.some(d => isEventOfType(d, 'contact_destroyed') && d.payload.contactId === e.payload.missileId));
  return {
    seed, strategy, endedAtS: world.time, hullPct: world.ownShip.hullPct, shipLost: world.weapons.shipLost,
    s7LaunchedAtS: launched(STRAIT_IDS.s7), s7VisualAtS, s7EngagedAtS: engaged(STRAIT_IDS.s7), s7Stopped: stopped(STRAIT_IDS.s7),
    a1LaunchedAtS: launched(STRAIT_IDS.a1), a1EngagedAtS: engaged(STRAIT_IDS.a1), a1Stopped: stopped(STRAIT_IDS.a1),
    a1MissilesLaunched: a1Missiles.length,
    a1MissilesHit: a1Impacts.filter(e => isEventOfType(e, 'missile_impact') && e.payload.hit).length,
    a1MissilesIntercepted: a1Intercepted.length,
    a1MissilesMissed: a1Impacts.filter(e => isEventOfType(e, 'missile_impact') && !e.payload.hit).length,
    a1MissilesUnresolved: a1Missiles.length - a1Impacts.length - a1Intercepted.length,
    a9EngagedAtS: engaged(STRAIT_IDS.a9), a9ShotDown: stopped(STRAIT_IDS.a9), a9Spawned: !!world.contactById(STRAIT_IDS.a9),
  };
}

export function runPlaytests(seeds: readonly number[] = Array.from({ length: 20 }, (_, i) => i + 1)): PlaytestResult[] {
  return STRATEGIES.flatMap(strategy => seeds.map(seed => runPlaytest(strategy, seed)));
}

/** Counts every scenario, including those terminated by ship loss. */
export function summarizePlaytests(results: readonly PlaytestResult[]) {
  return STRATEGIES.map(strategy => {
    const runs = results.filter(r => r.strategy === strategy);
    const count = (predicate: (r: PlaytestResult) => boolean) => runs.filter(predicate).length;
    return {
      strategy, runs: runs.length,
      damaged: count(r => r.hullPct < 100), lost: count(r => r.shipLost),
      s7StoppedBeforeLaunch: count(r => r.s7Stopped && r.s7LaunchedAtS === null),
      s7EngagedBeforeLaunch: count(r => r.s7EngagedAtS !== null && (r.s7LaunchedAtS === null || r.s7EngagedAtS < r.s7LaunchedAtS)),
      s7Launched: count(r => r.s7LaunchedAtS !== null),
      a1StoppedOrMissilesIntercepted: count(r => r.a1Stopped && r.a1LaunchedAtS === null || r.a1MissilesLaunched > 0 && r.a1MissilesIntercepted === r.a1MissilesLaunched),
      a9ShotDown: count(r => r.a9ShotDown), a9NotReached: count(r => !r.a9Spawned),
    };
  });
}
