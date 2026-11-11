import type { World } from '../sim/world';
import type { Command } from '../sim/commands';
import { executeCommand, validateCommand } from '../sim/commands';

export interface CommandControls {
  update(): void;
  destroy(): void;
}

export function createCommandControls(
  world: World,
  root: HTMLElement,
  durationS: number = 900,
): CommandControls {
  // --- State ---
  let ended = false;
  let eventCursor = 0;
  let inputsDirty = false;

  // --- DOM Construction ---
  const container = document.createElement('div');
  container.id = 'command-controls';
  container.style.display = 'flex';
  container.style.alignItems = 'center';
  container.style.gap = '0.75rem';
  container.style.flexWrap = 'wrap';

  // Inventory display
  const inventoryEl = document.createElement('span');
  inventoryEl.id = 'weapon-inventory';
  inventoryEl.textContent = 'SAM:24 CHAFF:6 GUN:40 CIWS:1000';
  container.appendChild(inventoryEl);

  // Point defense toggle
  const pdButton = document.createElement('button');
  pdButton.type = 'button';
  pdButton.id = 'point-defense-toggle';
  pdButton.textContent = 'PD: AUTO';
  pdButton.addEventListener('click', () => {
    if (ended) return;
    const currentMode = world.weapons.pointDefense;
    const nextMode = currentMode === 'auto' ? 'manual' : 'auto';
    const cmd: Command = { action: 'set_point_defense', mode: nextMode };
    const result = executeCommand(world, cmd, 'player');
    if (!result.ok) {
      setStatus(result.error);
    }
  });
  container.appendChild(pdButton);

  // Chaff button
  const chaffButton = document.createElement('button');
  chaffButton.type = 'button';
  chaffButton.id = 'deploy-chaff';
  chaffButton.textContent = 'Chaff';
  chaffButton.addEventListener('click', () => {
    if (ended) return;
    const cmd: Command = { action: 'chaff' };
    const result = executeCommand(world, cmd, 'player');
    if (!result.ok) {
      setStatus(result.error);
    }
  });
  container.appendChild(chaffButton);

  // Maneuver controls
  const maneuverGroup = document.createElement('span');
  maneuverGroup.style.display = 'inline-flex';
  maneuverGroup.style.alignItems = 'center';
  maneuverGroup.style.gap = '0.3rem';

  const courseLabel = document.createElement('label');
  courseLabel.textContent = 'CRS';
  courseLabel.setAttribute('for', 'own-course');
  maneuverGroup.appendChild(courseLabel);

  const courseInput = document.createElement('input');
  courseInput.type = 'number';
  courseInput.id = 'own-course';
  courseInput.min = '0';
  courseInput.max = '359.9';
  courseInput.step = '0.1';
  courseInput.value = String(world.ownShip.courseDeg);
  courseInput.style.width = '4rem';
  courseInput.addEventListener('input', () => {
    inputsDirty = true;
  });
  maneuverGroup.appendChild(courseInput);

  const speedLabel = document.createElement('label');
  speedLabel.textContent = 'SPD';
  speedLabel.setAttribute('for', 'own-speed');
  maneuverGroup.appendChild(speedLabel);

  const speedInput = document.createElement('input');
  speedInput.type = 'number';
  speedInput.id = 'own-speed';
  speedInput.min = '0';
  speedInput.max = '35';
  speedInput.step = '0.1';
  speedInput.value = String(world.ownShip.speedKts);
  speedInput.style.width = '3rem';
  speedInput.addEventListener('input', () => {
    inputsDirty = true;
  });
  maneuverGroup.appendChild(speedInput);

  const maneuverButton = document.createElement('button');
  maneuverButton.type = 'button';
  maneuverButton.id = 'maneuver-submit';
  maneuverButton.textContent = 'Maneuver';
  maneuverButton.addEventListener('click', () => {
    if (ended) return;
    const courseDeg = parseFloat(courseInput.value);
    const speedKts = parseFloat(speedInput.value);
    const cmd: Command = { action: 'maneuver', courseDeg, speedKts };
    const result = executeCommand(world, cmd, 'player');
    if (!result.ok) {
      setStatus(result.error);
    } else {
      inputsDirty = false;
    }
  });
  maneuverGroup.appendChild(maneuverButton);

  container.appendChild(maneuverGroup);

  // Status text
  const statusEl = document.createElement('span');
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');
  statusEl.style.color = '#ff8800';
  statusEl.style.fontSize = 'var(--text-secondary-size)';
  statusEl.style.minWidth = '6rem';
  container.appendChild(statusEl);

  root.appendChild(container);

  // --- Helpers ---
  function setStatus(msg: string): void {
    statusEl.textContent = msg;
  }

  function clearStatus(): void {
    statusEl.textContent = '';
  }

  function detectEnd(): void {
    if (ended) return;

    // Preferred: time-based check
    if (world.time >= durationS - 1e-6) {
      ended = true;
      return;
    }

    // Scan new events only (cursor-based)
    const events = world.events;
    while (eventCursor < events.length) {
      const ev = events[eventCursor];
      eventCursor++;
      if (ev.type === 'ship_lost' || ev.type === 'scenario-end') {
        ended = true;
        return;
      }
    }
  }

  function disableAll(): void {
    pdButton.disabled = true;
    chaffButton.disabled = true;
    courseInput.disabled = true;
    speedInput.disabled = true;
    maneuverButton.disabled = true;
  }

  // --- Public API ---
  function update(): void {
    detectEnd();

    if (ended) {
      disableAll();
      return;
    }

    // Inventory (every frame)
    const inv = world.ownShip.inventory;
    inventoryEl.textContent = `SAM:${inv.sam} CHAFF:${inv.chaff} GUN:${inv.gunBursts} CIWS:${inv.ciws}`;

    // Point defense mode (from world state, never cached)
    const mode = world.weapons.pointDefense;
    pdButton.textContent = `PD: ${mode.toUpperCase()}`;

    // Chaff availability via validateCommand
    const chaffCmd: Command = { action: 'chaff' };
    const chaffValid = validateCommand(world, chaffCmd);
    chaffButton.disabled = !chaffValid.ok;
    if (!chaffValid.ok) {
      chaffButton.title = chaffValid.error;
    } else {
      chaffButton.removeAttribute('title');
    }

    // Maneuver button availability
    const courseDeg = parseFloat(courseInput.value);
    const speedKts = parseFloat(speedInput.value);
    const maneuverCmd: Command = { action: 'maneuver', courseDeg, speedKts };
    const maneuverValid = validateCommand(world, maneuverCmd);
    maneuverButton.disabled = !maneuverValid.ok;
    if (!maneuverValid.ok) {
      maneuverButton.title = maneuverValid.error;
    } else {
      maneuverButton.removeAttribute('title');
    }

    // Don't overwrite unsent edits
    if (!inputsDirty) {
      const currentCourse = String(world.ownShip.courseDeg);
      const currentSpeed = String(world.ownShip.speedKts);
      if (courseInput.value !== currentCourse) {
        courseInput.value = currentCourse;
      }
      if (speedInput.value !== currentSpeed) {
        speedInput.value = currentSpeed;
      }
    }
  }

  function destroy(): void {
    if (container.parentNode) {
      container.parentNode.removeChild(container);
    }
  }

  return { update, destroy };
}
