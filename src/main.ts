import './styles.css';
import { createRadar } from './ui/radar';
import { DEFAULT_RANGE_NM } from './ui/radarProjection';
import { pickContact, PICK_TOLERANCE_PX, visibleContacts } from './ui/contactSelection';
import { createContactPanel } from './ui/contactPanel';
import type { ContactPanel } from './ui/contactPanel';
import { rangeTo } from './sim/geo';
import { parseConfig, randomSeed } from './config';
import { GameClock } from './sim/clock';
import { createHud } from './ui/hud';
import { STRAIT_TRANSIT } from './sim/scenario/strait';
import { loadScenario } from './sim/scenario/scenario';

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = text;
  }
}

const config = parseConfig(window.location.search, randomSeed());

const { world, runner } = loadScenario(STRAIT_TRANSIT, config.seed);

const clock = new GameClock({ timescale: config.timescale, durationS: STRAIT_TRANSIT.durationS });

clock.onStep((dt) => {
  world.step(dt);
  runner.update();
});

clock.onEnd((t) => {
  world.logEvent('scenario-end', 'crew-auto', { t });
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
let panel: ContactPanel | null = null;

const panelRoot = document.getElementById('contact-panel');
if (panelRoot instanceof HTMLElement) {
  panel = createContactPanel(panelRoot);
  panel.setActions([]);
}

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

    clock.advance(delta);
    hud.setClock(clock.time);
    hud.setHull(world.ownShip.hullPct);

    const tracks = world.visibleTracks();

    let selectedContact = selectedId !== null
      ? visibleContacts(tracks, world.ownShip.position, radar.getRange()).find((c) => c.id === selectedId) ?? null
      : null;

    if (selectedId !== null && selectedContact === null) {
      selectedId = null;
    }

    radar.render({
      ownShip: world.ownShip,
      contacts: tracks,
      selectedId,
    });

    if (panel !== null) {
      panel.update(selectedContact, world.ownShip);
    }

    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}
