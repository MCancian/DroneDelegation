import type { Behavior, Contact, Domain, MotionState, OwnShip, Vec2 } from './types';
import {
  angleDiff,
  bearingTo,
  degToRad,
  knotsToNmPerSec,
  move,
  normalizeDeg,
  rangeTo,
  velocityFrom,
} from './geo';
import type { Rng } from './rng';

export const DEFAULT_TURN_RATE_DEG_PER_SEC: Record<Domain, number> = {
  air: 3,
  surface: 2,
  missile: 6,
};

export const DEFAULT_CLIMB_RATE_FPM = 2000;
export const DEFAULT_LOITER_RETARGET_S = 60;

export function turnRadiusNm(speedKts: number, turnRateDegPerSec: number): number {
  if (turnRateDegPerSec <= 0) return Infinity;
  return (speedKts / 3600) / degToRad(turnRateDegPerSec);
}

export function turnToward(
  currentDeg: number,
  desiredDeg: number,
  maxRateDegPerSec: number,
  dtS: number,
): number {
  const diff = angleDiff(currentDeg, desiredDeg);
  const maxStep = maxRateDegPerSec * dtS;
  if (Math.abs(diff) <= maxStep) {
    return normalizeDeg(desiredDeg);
  }
  return normalizeDeg(currentDeg + Math.sign(diff) * maxStep);
}

export function leadPursuitCourse(
  pursuer: Vec2,
  speedKts: number,
  target: Vec2,
  targetCourseDeg: number,
  targetSpeedKts: number,
): number | null {
  const rx = target.x - pursuer.x;
  const ry = target.y - pursuer.y;
  const v = velocityFrom(targetCourseDeg, targetSpeedKts);
  const s = knotsToNmPerSec(speedKts);

  const a = v.x * v.x + v.y * v.y - s * s;
  const b = 2 * (rx * v.x + ry * v.y);
  const c = rx * rx + ry * ry;

  let t: number | null = null;

  if (Math.abs(a) < 1e-12) {
    // Linear case: bt + c = 0
    if (Math.abs(b) < 1e-12) return null;
    const lt = -c / b;
    if (lt > 0) t = lt;
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return null;
    const sqrtD = Math.sqrt(discriminant);
    const t1 = (-b + sqrtD) / (2 * a);
    const t2 = (-b - sqrtD) / (2 * a);
    const candidates: number[] = [];
    if (t1 > 0) candidates.push(t1);
    if (t2 > 0) candidates.push(t2);
    if (candidates.length === 0) return null;
    t = Math.min(...candidates);
  }

  if (t === null) return null;

  const aimX = target.x + v.x * t;
  const aimY = target.y + v.y * t;
  return bearingTo(pursuer, { x: aimX, y: aimY });
}

function freshState(contact: Contact): MotionState {
  return {
    waypointIndex: 0,
    waypointsDone: false,
    loiterCourseDeg: contact.courseDeg,
    loiterTimerS: 0,
  };
}

export function setBehavior(contact: Contact, behavior: Behavior): void {
  contact.motion = {
    behavior,
    schedule: contact.motion?.schedule ?? [],
    state: freshState(contact),
  };
}

export function stepKinematics(
  contact: Contact,
  ownShip: OwnShip,
  timeS: number,
  dtS: number,
  rng: Rng,
): void {
  if (!contact.alive || !(dtS > 0)) return;

  if (!contact.motion) {
    contact.position = move(contact.position, contact.courseDeg, contact.speedKts, dtS);
    return;
  }

  const motion = contact.motion;

  if (!motion.state) {
    motion.state = freshState(contact);
  }

  // Process schedule
  while (motion.schedule && motion.schedule.length > 0) {
    const entry = motion.schedule[0];
    let satisfied = false;
    if (entry.when.kind === 'time') {
      satisfied = timeS >= entry.when.atS;
    } else {
      satisfied = rangeTo(contact.position, ownShip.position) <= entry.when.rangeNm;
    }
    if (!satisfied) break;
    motion.schedule.shift();
    motion.behavior = entry.behavior;
    motion.state = freshState(contact);
  }

  const behavior = motion.behavior;
  const state = motion.state;
  const rate = behavior.turnRateDegPerSec ?? DEFAULT_TURN_RATE_DEG_PER_SEC[contact.domain];

  let desired: number;
  let speed: number;

  switch (behavior.kind) {
    case 'straight': {
      desired = behavior.courseDeg ?? contact.courseDeg;
      speed = behavior.speedKts ?? contact.speedKts;
      break;
    }
    case 'waypoints': {
      speed = behavior.speedKts ?? contact.speedKts;
      const arriveRadius =
        behavior.arriveRadiusNm ??
        Math.max(0.1, 1.05 * turnRadiusNm(speed, rate));

      while (
        !state.waypointsDone &&
        behavior.points.length > 0 &&
        state.waypointIndex < behavior.points.length &&
        rangeTo(contact.position, behavior.points[state.waypointIndex]) <= arriveRadius
      ) {
        state.waypointIndex++;
        if (state.waypointIndex >= behavior.points.length) {
          state.waypointsDone = true;
        }
      }

      if (state.waypointsDone || behavior.points.length === 0) {
        desired = contact.courseDeg;
      } else {
        desired = bearingTo(contact.position, behavior.points[state.waypointIndex]);
      }
      break;
    }
    case 'loiter': {
      speed = behavior.speedKts;
      state.loiterTimerS -= dtS;
      if (state.loiterTimerS <= 0) {
        state.loiterTimerS = behavior.retargetS ?? DEFAULT_LOITER_RETARGET_S;
        state.loiterCourseDeg = normalizeDeg(contact.courseDeg + rng.range(-60, 60));
      }
      if (rangeTo(contact.position, behavior.center) > 0.7 * behavior.radiusNm) {
        state.loiterCourseDeg = bearingTo(contact.position, behavior.center);
      }
      desired = state.loiterCourseDeg;
      break;
    }
    case 'closeOnOwnship': {
      speed = behavior.speedKts;
      const dist = rangeTo(contact.position, ownShip.position);
      if (dist < 0.05) {
        desired = contact.courseDeg;
      } else {
        const pure = bearingTo(contact.position, ownShip.position);
        if (behavior.mode === 'lead') {
          const lead = leadPursuitCourse(
            contact.position,
            speed,
            ownShip.position,
            ownShip.courseDeg,
            ownShip.speedKts,
          );
          desired = lead ?? pure;
        } else {
          desired = pure;
        }
      }
      break;
    }
    case 'turnAway': {
      desired = behavior.courseDeg;
      speed = behavior.speedKts ?? contact.speedKts;
      break;
    }
  }

  contact.courseDeg = turnToward(contact.courseDeg, desired, rate, dtS);
  contact.speedKts = speed;

  // Altitude
  if (behavior.targetAltitudeFt !== undefined) {
    const climbRate = behavior.climbRateFpm ?? DEFAULT_CLIMB_RATE_FPM;
    const step = (climbRate / 60) * dtS;
    const diff = behavior.targetAltitudeFt - contact.altitudeFt;
    if (Math.abs(diff) <= step) {
      contact.altitudeFt = behavior.targetAltitudeFt;
    } else {
      contact.altitudeFt += Math.sign(diff) * step;
    }
  }

  contact.position = move(contact.position, contact.courseDeg, contact.speedKts, dtS);
}
