import './styles.css';
import { createRadar } from './ui/radar';
import { DEFAULT_RANGE_NM } from './ui/radarProjection';
import { pickContact, PICK_TOLERANCE_PX, visibleContacts } from './ui/contactSelection';
import { createContactPanel } from './ui/contactPanel';
import type { ContactPanel, ContactAction } from './ui/contactPanel';
import { createCommandControls } from './ui/commandControls';
import type { CommandControls } from './ui/commandControls';
import { createCrewFeed } from './ui/crewFeed';
import type { CrewFeed } from './ui/crewFeed';
import { rangeTo } from './sim/geo';
import { parseConfig, randomSeed } from './config';
import { GameClock } from './sim/clock';
import { createHud } from './ui/hud';
import { STRAIT_TRANSIT } from './sim/scenario/strait';
import { loadScenario } from './sim/scenario/scenario';
import { executeCommand, validateCommand } from './sim/commands';
import type { Command } from './sim/commands';
import type { Classification, RadarContact } from './sim/types';

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = text;
  }
}

const config = parseConfig(window.location.search, randomSeed(), import.meta.env.DEV);

const { world, runner } = loadScenario(STRAIT_TRANSIT, config.seed);

const clock = new GameClock({ timescale: config.timescale, durationS: STRAIT_TRANSIT.durationS });

clock.onStep((dt) => {
  world.step(dt);
  runner.update();
});

let scenarioEndReported = false;

clock.onEnd((t) => {
  if (!scenarioEndReported) {
    scenarioEndReported = true;
    world.logEvent('scenario-end', 'crew-auto', { t });
  }
});

const hud = createHud();
hud.setClock(0);
hud.setHull(world.ownShip.hullPct);

setText('autonomy-air', 'Air: HOLD');
setText('autonomy-surface', 'Surface: HOLD');

const canvas = document.getElementById('radar-canvas');
const rangeButtons = document.getElementById('range-buttons');

function markActiveRange(rangeNm: number): void {
  if (!(rangeButtons instanceof HTMLElement)) {
    return;
  }

  const buttons = rangeButtons.querySelectorAll<HTMLButtonElement>('button[data-range]');
  buttons.forEach((button) => {
    const buttonRange = Number(button.dataset.range);
    button.classList.toggle('active', buttonRange === rangeNm);
  });
}

let selectedId: string | null = null;

const crewFeedRoot = document.getElementById('crew-feed');
let crewFeed: CrewFeed | null = null;
if (crewFeedRoot instanceof HTMLElement) {
  crewFeed = createCrewFeed(crewFeedRoot, (contactId: string) => {
    const tracks = world.visibleTracks();
    const found = tracks.find((c) => c.id === contactId && c.alive);
    if (found) {
      selectedId = contactId;
    }
  });
}

let panel: ContactPanel | null = null;

const panelRoot = document.getElementById('contact-panel');
if (panelRoot instanceof HTMLElement) {
  panel = createContactPanel(panelRoot);
  panel.setActions([]);
}

// Command controls in topbar
const topbar = document.getElementById('topbar');
let controls: CommandControls | null = null;
if (topbar instanceof HTMLElement) {
  controls = createCommandControls(world, topbar, STRAIT_TRANSIT.durationS);
}

// Status element for runtime failures
let statusEl: HTMLElement | null = null;
if (topbar instanceof HTMLElement) {
  statusEl = topbar.querySelector('[role="status"]');
}

function showStatus(msg: string): void {
  if (statusEl) {
    statusEl.textContent = msg;
  }
}

function clearStatus(): void {
  if (statusEl) {
    statusEl.textContent = '';
  }
}

// --- Action building for selected contact ---

const CLASSIFICATIONS: readonly Classification[] = ['unknown', 'neutral', 'friendly', 'suspect', 'hostile'];

function buildActionsForContact(
  contact: RadarContact,
  w: typeof world,
): ContactAction[] {
  const actions: ContactAction[] = [];

  // Own missiles show no actions
  if (contact.ownMissile) {
    return actions;
  }

  const domain = contact.domain;

  // Domain-appropriate actions only
  if (domain === 'air') {
    // IFF challenge
    const iffCmd: Command = { action: 'iff_challenge', target: contact.id };
    const iffValid = validateCommand(w, iffCmd);
    actions.push({
      id: 'iff_challenge',
      label: 'IFF',
      disabled: !iffValid.ok,
      disabledReason: !iffValid.ok ? iffValid.error : undefined,
      onClick: () => dispatch(iffCmd),
    });

    // Radio warning
    const radioCmd: Command = { action: 'radio_warning', target: contact.id };
    const radioValid = validateCommand(w, radioCmd);
    actions.push({
      id: 'radio_warning',
      label: 'Radio',
      disabled: !radioValid.ok,
      disabledReason: !radioValid.ok ? radioValid.error : undefined,
      onClick: () => dispatch(radioCmd),
    });

    // Illuminate
    const illumCmd: Command = { action: 'illuminate', target: contact.id };
    const illumValid = validateCommand(w, illumCmd);
    actions.push({
      id: 'illuminate',
      label: 'Illum',
      disabled: !illumValid.ok,
      disabledReason: !illumValid.ok ? illumValid.error : undefined,
      onClick: () => dispatch(illumCmd),
    });

    // SAM
    const samCmd: Command = { action: 'engage_sam', target: contact.id };
    const samValid = validateCommand(w, samCmd);
    actions.push({
      id: 'engage_sam',
      label: 'SAM',
      disabled: !samValid.ok,
      disabledReason: !samValid.ok ? samValid.error : undefined,
      onClick: () => dispatch(samCmd),
    });
  } else if (domain === 'surface') {
    // Hail
    const hailCmd: Command = { action: 'hail', target: contact.id };
    const hailValid = validateCommand(w, hailCmd);
    actions.push({
      id: 'hail',
      label: 'Hail',
      disabled: !hailValid.ok,
      disabledReason: !hailValid.ok ? hailValid.error : undefined,
      onClick: () => dispatch(hailCmd),
    });

    // Radio warning
    const radioCmd: Command = { action: 'radio_warning', target: contact.id };
    const radioValid = validateCommand(w, radioCmd);
    actions.push({
      id: 'radio_warning',
      label: 'Radio',
      disabled: !radioValid.ok,
      disabledReason: !radioValid.ok ? radioValid.error : undefined,
      onClick: () => dispatch(radioCmd),
    });

    // Warning shots
    const wsCmd: Command = { action: 'warning_shots', target: contact.id };
    const wsValid = validateCommand(w, wsCmd);
    actions.push({
      id: 'warning_shots',
      label: 'WarnShots',
      disabled: !wsValid.ok,
      disabledReason: !wsValid.ok ? wsValid.error : undefined,
      onClick: () => dispatch(wsCmd),
    });

    // Gun
    const gunCmd: Command = { action: 'engage_gun', target: contact.id };
    const gunValid = validateCommand(w, gunCmd);
    actions.push({
      id: 'engage_gun',
      label: 'Gun',
      disabled: !gunValid.ok,
      disabledReason: !gunValid.ok ? gunValid.error : undefined,
      onClick: () => dispatch(gunCmd),
    });
  } else if (domain === 'missile') {
    // SAM (for inbound missiles)
    const samCmd: Command = { action: 'engage_sam', target: contact.id };
    const samValid = validateCommand(w, samCmd);
    actions.push({
      id: 'engage_sam',
      label: 'SAM',
      disabled: !samValid.ok,
      disabledReason: !samValid.ok ? samValid.error : undefined,
      onClick: () => dispatch(samCmd),
    });

    // CIWS
    const ciwsCmd: Command = { action: 'ciws', target: contact.id };
    const ciwsValid = validateCommand(w, ciwsCmd);
    actions.push({
      id: 'ciws',
      label: 'CIWS',
      disabled: !ciwsValid.ok,
      disabledReason: !ciwsValid.ok ? ciwsValid.error : undefined,
      onClick: () => dispatch(ciwsCmd),
    });
  }

  // Classify dropdown (available for all non-own-missile contacts)
  for (const cls of CLASSIFICATIONS) {
    const clsCmd: Command = { action: 'classify', target: contact.id, classification: cls };
    const clsValid = validateCommand(w, clsCmd);
    actions.push({
      id: `classify_${cls}`,
      label: cls.toUpperCase(),
      disabled: !clsValid.ok,
      disabledReason: !clsValid.ok ? clsValid.error : undefined,
      onClick: () => dispatch(clsCmd),
    });
  }

  return actions;
}

function dispatch(cmd: Command): void {
  const result = executeCommand(world, cmd, 'player');
  if (!result.ok) {
    showStatus(result.error);
  } else {
    clearStatus();
  }
}

// --- Clock/ship-lost end detection ---
let clockStopped = false;
let shipLostDetected = false;
let eventCursor = 0;

function detectEnd(): void {
  if (clockStopped) return;

  // Check ship loss via events
  const events = world.events;
  while (eventCursor < events.length) {
    const ev = events[eventCursor];
    eventCursor++;
    if (ev.type === 'ship_lost') {
      shipLostDetected = true;
      clockStopped = true;
      if (!scenarioEndReported) {
        scenarioEndReported = true;
        world.logEvent('scenario-end', 'crew-auto', { t: world.time });
      }
      return;
    }
  }

  // Check clock ended
  if (clock.ended) {
    clockStopped = true;
  }
}

// --- Radar and frame loop ---
if (canvas instanceof HTMLCanvasElement) {
  const radar = createRadar(canvas, {
    rangeNm: DEFAULT_RANGE_NM,
    onRangeChange: (nm) => {
      markActiveRange(nm);
    },
  });

  markActiveRange(radar.getRange());

  if (rangeButtons instanceof HTMLElement) {
    rangeButtons.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const button = target.closest<HTMLButtonElement>('button[data-range]');
      if (!button || !rangeButtons.contains(button)) {
        return;
      }

      const range = Number(button.dataset.range);
      if (Number.isFinite(range)) {
        radar.setRange(range);
      }
    });
  }

  canvas.addEventListener('click', (event) => {
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;

    const worldPt = radar.screenToWorld(px, py);
    const worldOffset = radar.screenToWorld(px + PICK_TOLERANCE_PX, py);
    const toleranceNm = rangeTo(worldPt, worldOffset);

    const tracks = world.visibleTracks();
    const visible = visibleContacts(tracks, world.ownShip.position, radar.getRange());
    const picked = pickContact(visible, worldPt, toleranceNm);
    selectedId = picked !== null ? picked.id : null;
  });

  let lastTs: number | null = null;

  const frame = (ts: number): void => {
    const delta = lastTs === null ? 0 : (ts - lastTs) / 1000;
    lastTs = ts;

    if (!clockStopped) {
      clock.advance(delta);
    }

    detectEnd();

    hud.setClock(clock.time);
    hud.setHull(world.ownShip.hullPct);

    const tracks = world.visibleTracks();

    // Preserve selection: only clear if track disappears or dies (not on range zoom)
    let selectedContact: RadarContact | null = null;
    if (selectedId !== null) {
      const found = tracks.find((c) => c.id === selectedId);
      if (found !== undefined && found.alive) {
        selectedContact = found;
      } else {
        selectedId = null;
      }
    }

    radar.render({
      ownShip: world.ownShip,
      contacts: tracks,
      selectedId,
    });

    if (panel !== null) {
      panel.update(selectedContact, world.ownShip);

      // Build actions for selected contact
      if (selectedContact !== null && !clockStopped) {
        const actions = buildActionsForContact(selectedContact, world);
        panel.setActions(actions);
      } else if (selectedContact !== null && clockStopped) {
        panel.setActions([]);
      } else {
        panel.setActions([]);
      }
    }

    if (controls !== null) {
      controls.update();
    }

    if (crewFeed !== null) {
      crewFeed.update(world.events);
    }

    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}
