import type { World } from '../sim/world';
import type { Command } from '../sim/commands';
import type { AutonomyDomain, AutonomyLevel, AutonomyState } from '../sim/types';

export type { AutonomyDomain, AutonomyLevel, AutonomyState } from '../sim/types';

export type AutonomyDecision = 'execute' | 'needs_consent' | 'veto_window' | 'advise_only';

export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = ['HOLD', 'CONSENT', 'VETO', 'WEAPONS_FREE'];

/** Policy is independent of UI and of the source of a proposal. */
export function decide(level: AutonomyLevel, _proposal?: unknown): AutonomyDecision {
  switch (level) {
    case 'WEAPONS_FREE': return 'execute';
    case 'VETO': return 'veto_window';
    case 'CONSENT': return 'needs_consent';
    case 'HOLD': return 'advise_only';
    default: return 'advise_only';
  }
}

/** Return the domain from the visible target only. Unknown targets are not authorized. */
export function commandDomain(world: World, command: Command): AutonomyDomain | null {
  if (!('target' in command)) return null;
  const matches = world.visibleTracks().filter(track => track.id === command.target && track.alive && !track.ownMissile);
  if (matches.length !== 1) return null;
  return matches[0].domain === 'surface' ? 'surface' : 'air';
}

/** Clone the current levels so event history is not mutated by later changes. */
export function autonomySnapshot(world: World): AutonomyState {
  return { ...world.autonomy };
}

/** Record actual player changes once; selecting the current level is a no-op. */
export function setAutonomy(world: World, domain: AutonomyDomain, level: AutonomyLevel): void {
  if ((domain !== 'air' && domain !== 'surface') || !AUTONOMY_LEVELS.includes(level)) return;
  const previous = world.autonomy[domain];
  if (previous === level) return;
  world.autonomy[domain] = level;
  world.logEvent('autonomy_changed', 'player', {
    domain, previous, level, autonomy: { ...world.autonomy, pointDefense: world.weapons.pointDefense },
  });
}
