import { isEventOfType } from '../sim/events';
import type { GameEvent } from '../sim/types';

export interface CrewFeed {
  update(events: readonly GameEvent[]): void;
  destroy(): void;
}

export function formatCrewTimestamp(t: number): string {
  const safe = Number.isFinite(t) && t >= 0 ? t : 0;
  const totalSec = Math.floor(safe);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `T+${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

interface CrewPayload {
  station?: string;
  priority?: string;
  text?: string;
  contactId?: string;
  trackId?: string;
}

function stripStationPrefix(text: string, station: string): string {
  if (!station) return text;
  const withSpace = station + ': ';
  if (text.startsWith(withSpace)) return text.slice(withSpace.length);
  const noSpace = station + ':';
  if (text.startsWith(noSpace)) return text.slice(noSpace.length).replace(/^ /, '');
  return text;
}

export function createCrewFeed(
  root: HTMLElement,
  onSelect: (contactId: string) => void,
): CrewFeed {
  while (root.firstChild) {
    root.removeChild(root.firstChild);
  }

  const heading = document.createElement('h2');
  heading.textContent = 'Crew Feed';
  root.appendChild(heading);

  const list = document.createElement('div');
  list.className = 'crew-feed-list';
  root.appendChild(list);

  let cursor = 0;
  let audioContext: AudioContext | null = null;
  let destroyed = false;

  const onGesture = (): void => {
    if (destroyed) return;
    try {
      const Ctx: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      if (!audioContext) {
        audioContext = new Ctx();
      }
      if (audioContext.state === 'suspended') {
        audioContext.resume().catch(() => {});
      }
    } catch {
      // Audio API unavailable
    }
  };

  document.addEventListener('pointerdown', onGesture);
  document.addEventListener('keydown', onGesture);

  function playFlashBeep(): void {
    if (!audioContext) return;
    if (audioContext.state !== 'running') return;
    try {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.value = 0.08;
      osc.connect(gain);
      gain.connect(audioContext.destination);
      osc.start();
      osc.stop(audioContext.currentTime + 0.12);
    } catch {
      // Audio failure, silently ignore
    }
  }

  function update(events: readonly GameEvent[]): void {
    if (destroyed) return;

    let added = false;

    while (cursor < events.length) {
      const ev = events[cursor];
      cursor++;

      if (!isEventOfType(ev, 'crew-report')) continue;

      const payload: CrewPayload = ev.payload;
      const station = typeof payload.station === 'string' ? payload.station : '';
      const priority = typeof payload.priority === 'string' ? payload.priority : 'routine';
      const rawText = typeof payload.text === 'string' ? payload.text : '';
      const contactId = typeof payload.contactId === 'string' ? payload.contactId : undefined;
      const trackId = typeof payload.trackId === 'string' ? payload.trackId : undefined;

      const text = stripStationPrefix(rawText, station);

      const msg = document.createElement('div');
      msg.className = `crew-msg crew-msg-${priority}`;

      const ts = document.createElement('span');
      ts.className = 'crew-ts';
      ts.textContent = formatCrewTimestamp(ev.t);
      msg.appendChild(ts);

      const stationEl = document.createElement('span');
      stationEl.className = 'crew-station';
      stationEl.textContent = station;
      msg.appendChild(stationEl);

      const priorityEl = document.createElement('span');
      priorityEl.className = 'crew-priority';
      priorityEl.textContent = priority.toUpperCase();
      msg.appendChild(priorityEl);

      if (trackId) {
        const trackEl = document.createElement('span');
        trackEl.className = 'crew-track';
        trackEl.textContent = trackId;
        msg.appendChild(trackEl);
      }

      if (contactId) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'crew-select-btn';
        btn.textContent = text;
        const label = trackId || text || 'contact';
        btn.setAttribute('aria-label', `Select contact ${label}`);
        btn.addEventListener('click', () => {
          onSelect(contactId);
        });
        msg.appendChild(btn);
      } else {
        const textEl = document.createElement('span');
        textEl.className = 'crew-text';
        textEl.textContent = text;
        msg.appendChild(textEl);
      }

      list.appendChild(msg);
      added = true;

      if (priority === 'flash') {
        playFlashBeep();
      }
    }

    if (added) {
      list.scrollTop = list.scrollHeight;
    }
  }

  function destroy(): void {
    destroyed = true;
    document.removeEventListener('pointerdown', onGesture);
    document.removeEventListener('keydown', onGesture);
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
    while (root.firstChild) {
      root.removeChild(root.firstChild);
    }
  }

  return { update, destroy };
}
