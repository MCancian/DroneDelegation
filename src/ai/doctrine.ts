import type { World } from '../sim/world';
import type { SensorTrack, Vec2 } from '../sim/types';
import { angleDiff, bearingTo, closingSpeed, rangeTo, velocityFrom } from '../sim/geo';
import type { ObservedHostileAct } from './situation';
import type { ProposalManager } from './proposals';

// Implementation choices: a 2 nm group radius, 0.1 nm observed departure,
// and 12 s maximum observation age approximate group movement using radar data.
// They are not numerical requirements in the design's ROE-5.
const GROUP_RADIUS_NM = 2;
const DEPARTURE_NM = 0.1;
const MAX_TRACK_AGE_S = 12;

interface Match {
  since: number;
  logged: boolean;
}

interface SurfaceGroup {
  /** Last position while observed near another surface contact before rapid closing. */
  origin: Vec2;
  departed: boolean;
}

export interface DoctrineOptions {
  getHostileActs(): readonly ObservedHostileAct[];
  isEnded?(): boolean;
}

/**
 * The rules consume the same sensor tracks and observed hostile acts as the AI.
 * No contact truth, planned behavior, or unobserved missile launch is used.
 */
export class Doctrine {
  private lastEvaluation = -Infinity;
  private readonly firstBearings = new Map<string, number>();
  private readonly groups = new Map<string, SurfaceGroup>();
  private readonly matches = new Map<string, Match>();
  private readonly answeredHails = new Set<string>();
  private eventCursor = 0;

  constructor(
    private readonly world: World,
    private readonly proposals: ProposalManager,
    private readonly options: DoctrineOptions,
  ) {}

  update(): void {
    const world = this.world;
    if (this.options.isEnded?.() || world.weapons.shipLost) return;
    // A fixed-step game loop may call us ten times per second. The epsilon
    // avoids missing exact seconds to floating-point accumulation.
    if (world.time - this.lastEvaluation < 1 - 1e-7) return;
    this.lastEvaluation = world.time;

    this.readHailResponses();
    const tracks = world.visibleTracks().filter((t) => t.alive && !t.ownMissile);
    const surfaces = tracks.filter((t) => t.domain === 'surface');
    const seenMatches = new Set<string>();
    const own = world.ownShip;
    const ownVelocity = velocityFrom(own.courseDeg, own.speedKts);
    const hostileActs = this.options.getHostileActs();

    for (const track of tracks) {
      // Do not launch on an old coasted estimate after radar contact is lost.
      if (world.time - (track.lastSeen ?? world.time) > MAX_TRACK_AGE_S) continue;
      const bearing = bearingTo(own.position, track.position);
      if (!this.firstBearings.has(track.id)) this.firstBearings.set(track.id, bearing);
      const closing = closingSpeed(own.position, ownVelocity, track.position, velocityFrom(track.courseDeg, track.speedKts));
      const range = rangeTo(own.position, track.position);
      let rule: 'ROE-3' | 'ROE-5' | undefined;

      if (track.domain === 'air') {
        const initialBearing = this.firstBearings.get(track.id)!;
        const fromRed = initialBearing >= 20 && initialBearing <= 70;
        const profileMatch = hostileActs.some((act) =>
          act.t <= world.time && act.trackId !== track.trackId &&
          Math.abs(track.altitudeFt - act.altitudeFt) <= 1000 &&
          Math.abs(track.speedKts - act.speedKts) <= 30 &&
          Math.abs(angleDiff(initialBearing, act.bearingDeg)) <= 15,
        );
        if (fromRed && closing > 0 && profileMatch) rule = 'ROE-3';
      } else if (track.domain === 'surface') {
        const group = this.observeGroup(track, surfaces, closing);
        if (track.sensors.ais.kind === 'none' && group?.departed &&
            closing > 30 && !this.answeredHails.has(track.id)) {
          rule = 'ROE-5';
        }
      }

      if (!rule) continue;
      const key = `${rule}:${track.id}`;
      seenMatches.add(key);
      let match = this.matches.get(key);
      if (!match) {
        match = { since: world.time, logged: false };
        this.matches.set(key, match);
      }
      if (!match.logged) {
        world.logEvent('doctrine_match', 'doctrine', {
          rule, target: track.id, trackId: track.trackId, rangeNm: range,
        });
        match.logged = true;
      }

      const domain = rule === 'ROE-3' ? 'air' : 'surface';
      if (world.autonomy[domain] === 'HOLD' || world.time - match.since < 15 - 1e-7 ||
          this.proposals.hasTarget(track.id)) continue;

      if (rule === 'ROE-3') {
        if (range >= world.weapons.config.sam.minRangeNm && range <= world.weapons.config.sam.maxRangeNm) {
          this.proposals.submit({ action: 'engage_sam', target: track.id }, 'doctrine', 'ROE-3 observed hostile profile match');
        }
      } else if (range <= world.weapons.config.gun.maxRangeNm) {
        this.proposals.submit({ action: 'engage_gun', target: track.id }, 'doctrine', 'ROE-5 fast closing contact departed a group');
      }
      // SAM against surface targets is not a valid command in spec §8.
    }

    // Intermittently coasting tracks stay visible in the sensor model. An
    // actually lost contact or rule no longer matching restarts the delay.
    for (const key of this.matches.keys()) {
      if (!seenMatches.has(key)) this.matches.delete(key);
    }
  }

  private observeGroup(track: SensorTrack, surfaces: readonly SensorTrack[], closing: number): SurfaceGroup | undefined {
    let group = this.groups.get(track.id);
    if (closing <= 30) {
      const nearAnother = surfaces.some((other) =>
        other.id !== track.id &&
        this.world.time - (other.lastSeen ?? this.world.time) <= MAX_TRACK_AGE_S &&
        rangeTo(track.position, other.position) <= GROUP_RADIUS_NM,
      );
      if (nearAnother) {
        group = { origin: { ...track.position }, departed: false };
        this.groups.set(track.id, group);
      }
    } else if (group && rangeTo(group.origin, track.position) >= DEPARTURE_NM) {
      // A separation from the last grouped observation distinguishes a real
      // departure from a single speed reading while still within the group.
      group.departed = true;
    }
    return group;
  }

  private readHailResponses(): void {
    const events = this.world.events;
    while (this.eventCursor < events.length) {
      const event = events[this.eventCursor++];
      if (event.type !== 'command_response' || typeof event.payload !== 'object' || event.payload === null) continue;
      const payload = event.payload as Record<string, unknown>;
      if (payload.action === 'hail' && payload.outcome === 'answered' && typeof payload.target === 'string') {
        this.answeredHails.add(payload.target);
      }
    }
  }
}
