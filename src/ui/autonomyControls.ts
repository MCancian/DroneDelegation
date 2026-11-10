import { AUTONOMY_LEVELS, setAutonomy } from '../ai/autonomy';
import type { AutonomyDomain, AutonomyLevel } from '../sim/types';
import type { World } from '../sim/world';

export interface AutonomyControls {
  update(): void;
  destroy(): void;
}

const LABEL: Record<AutonomyLevel, string> = {
  HOLD: 'HOLD', CONSENT: 'CONSENT', VETO: 'VETO', WEAPONS_FREE: 'WEAPONS FREE',
};

const DESCRIPTION: Record<AutonomyLevel, string> = {
  HOLD: 'The assistant advises only.',
  CONSENT: 'Engagements require your approval and expire after 30 seconds of game time.',
  VETO: 'Engagements execute after 10 seconds of game time unless you cancel.',
  WEAPONS_FREE: 'The assistant may execute engagements immediately.',
};

/** Render independent controls for each weapons domain. */
export function createAutonomyControls(
  world: World,
  root: HTMLElement,
  isEnded: () => boolean = () => false,
): AutonomyControls {
  const buttons: Array<{ domain: AutonomyDomain; level: AutonomyLevel; button: HTMLButtonElement }> = [];
  const groups: HTMLElement[] = [];

  for (const domain of ['air', 'surface'] as const) {
    const group = document.createElement('div');
    group.className = 'autonomy-domain';
    group.dataset.domain = domain;
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', `${domain === 'air' ? 'Air' : 'Surface'} authority`);
    const label = document.createElement('span');
    label.className = 'autonomy-domain-label';
    label.textContent = domain === 'air' ? 'AIR' : 'SURFACE';
    group.append(label);

    for (const level of AUTONOMY_LEVELS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'autonomy-level';
      button.dataset.domain = domain;
      button.dataset.level = level;
      button.textContent = LABEL[level];
      button.title = DESCRIPTION[level];
      button.setAttribute('aria-label', `${domain === 'air' ? 'Air' : 'Surface'} ${LABEL[level]}: ${DESCRIPTION[level]}`);
      button.addEventListener('click', () => {
        if (isEnded()) return;
        setAutonomy(world, domain, level);
        update();
      });
      group.append(button);
      buttons.push({ domain, level, button });
    }
    groups.push(group);
  }
  root.replaceChildren(...groups);

  function update(): void {
    const ended = isEnded();
    for (const { domain, level, button } of buttons) {
      const active = world.autonomy[domain] === level;
      button.dataset.active = String(active);
      button.setAttribute('aria-pressed', String(active));
      button.disabled = ended;
    }
  }

  update();
  return { update, destroy: () => { for (const group of groups) group.remove(); } };
}
