import { isEventOfType } from '../sim/events';
import type { CrewRole } from '../sim/events';
import type { Domain, GameEvent } from '../sim/types';

export type CrewFeedTab = CrewRole | 'all';

export function crewRoleForReport(station: string, domain?: Domain): CrewRole {
  if (domain === 'air') return 'air-search';
  if (domain === 'surface') return 'surface-search';
  if (domain === 'missile') return 'weapons-officer';
  if (station === 'CIC' || station === 'TAO-Air' || station === 'Lookouts') return 'air-search';
  if (station === 'SWC') return 'surface-search';
  return 'weapons-officer';
}

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
  role?: CrewRole;
  domain?: Domain;
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
  const heading = document.createElement('h2');
  heading.textContent = 'Crew Feed';

  const controls = document.createElement('div');
  controls.className = 'crew-feed-controls';
  controls.setAttribute('role', 'tablist');
  controls.setAttribute('aria-label', 'Crew report categories');

  const tabs: { id: CrewFeedTab; label: string }[] = [
    { id: 'air-search', label: 'Air Search' },
    { id: 'surface-search', label: 'Surface Search' },
    { id: 'weapons-officer', label: 'Weapons Officer' },
    { id: 'all', label: 'All' },
  ];
  const tabButtons = new Map<CrewFeedTab, HTMLButtonElement>();
  const unreadBadges = new Map<CrewFeedTab, HTMLSpanElement>();
  const unread = new Map<CrewRole, number>([['air-search', 0], ['surface-search', 0], ['weapons-officer', 0]]);
  let selectedTab: CrewFeedTab = 'air-search';

  for (const tab of tabs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'crew-feed-tab';
    button.id = `crew-tab-${tab.id}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', 'crew-feed-list');
    button.setAttribute('aria-selected', String(tab.id === selectedTab));
    button.tabIndex = tab.id === selectedTab ? 0 : -1;
    button.dataset.domain = tab.id;
    button.append(document.createTextNode(tab.label));
    const badge = document.createElement('span');
    badge.className = 'crew-feed-unread';
    badge.hidden = true;
    badge.setAttribute('aria-hidden', 'true');
    button.appendChild(badge);
    button.addEventListener('click', () => selectTab(tab.id));
    button.addEventListener('keydown', (event: KeyboardEvent) => {
      const index = tabs.findIndex((item) => item.id === tab.id);
      let target = -1;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') target = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') target = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') target = 0;
      else if (event.key === 'End') target = tabs.length - 1;
      if (target < 0) return;
      event.preventDefault();
      const next = tabs[target].id;
      selectTab(next);
      tabButtons.get(next)?.focus();
    });
    controls.appendChild(button);
    tabButtons.set(tab.id, button);
    unreadBadges.set(tab.id, badge);
  }

  const alerts = document.createElement('section');
  alerts.className = 'crew-feed-alerts';
  alerts.setAttribute('aria-label', 'Urgent crew alerts');
  alerts.setAttribute('aria-live', 'assertive');
  alerts.hidden = true;
  const alertList = document.createElement('div');
  alertList.className = 'crew-feed-alert-list';
  alerts.appendChild(alertList);

  const list = document.createElement('div');
  list.className = 'crew-feed-list';
  list.id = 'crew-feed-list';
  list.setAttribute('role', 'tabpanel');
  list.setAttribute('aria-labelledby', 'crew-tab-air-search');
  list.setAttribute('aria-live', 'off');

  root.replaceChildren(heading, controls, alerts, list);

  let cursor = 0;
  let audioContext: AudioContext | null = null;
  let destroyed = false;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  const entries: {
    t: number; role: CrewRole; station: string; priority: string; text: string; contactId?: string;
  }[] = [];

  function renderEntry(entry: typeof entries[number]): HTMLElement {
    const msg = document.createElement('div');
    msg.className = `crew-msg crew-msg-${entry.priority}`;
    msg.dataset.role = entry.role;

    const ts = document.createElement('span');
    ts.className = 'crew-ts';
    ts.textContent = formatCrewTimestamp(entry.t);
    msg.appendChild(ts);

    const stationEl = document.createElement('span');
    stationEl.className = 'crew-station';
    stationEl.textContent = entry.station;
    msg.appendChild(stationEl);

    if (entry.contactId) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'crew-select-btn';
      button.textContent = entry.text;
      button.setAttribute('aria-label', `Select reported contact: ${entry.text}`);
      button.addEventListener('click', () => onSelect(entry.contactId!));
      msg.appendChild(button);
    } else {
      const text = document.createElement('span');
      text.className = 'crew-text';
      text.textContent = entry.text;
      msg.appendChild(text);
    }

    return msg;
  }

  function updateUnread(): void {
    for (const [tab, button] of tabButtons) {
      const count = tab === 'all'
        ? Array.from(unread.values()).reduce((total, value) => total + value, 0)
        : unread.get(tab) ?? 0;
      const badge = unreadBadges.get(tab)!;
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.hidden = count === 0;
      const tabLabel = tabs.find((item) => item.id === tab)!.label;
      button.setAttribute('aria-label', count > 0 ? `${tabLabel}, ${count} unread` : tabLabel);
    }
  }

  function renderList(): void {
    const visible = selectedTab === 'all' ? entries : entries.filter((entry) => entry.role === selectedTab);
    list.replaceChildren(...visible.map(renderEntry));
    list.setAttribute('aria-labelledby', `crew-tab-${selectedTab}`);
    list.scrollTop = list.scrollHeight;
  }

  function selectTab(tab: CrewFeedTab): void {
    selectedTab = tab;
    const button = tabButtons.get(tab);
    if (!button) return;
    for (const [id, candidate] of tabButtons) {
      candidate.setAttribute('aria-selected', String(id === tab));
      candidate.tabIndex = id === tab ? 0 : -1;
    }
    if (tab === 'all') {
      for (const role of unread.keys()) unread.set(role, 0);
    } else {
      unread.set(tab, 0);
    }
    updateUnread();
    renderList();
  }

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

    const added: HTMLElement[] = [];

    while (cursor < events.length) {
      const ev = events[cursor];
      cursor++;

      if (!isEventOfType(ev, 'crew-report')) continue;

      const payload: CrewPayload = ev.payload;
      const station = typeof payload.station === 'string' ? payload.station : '';
      const priority = typeof payload.priority === 'string' ? payload.priority : 'routine';
      const rawText = typeof payload.text === 'string' ? payload.text : '';
      const contactId = typeof payload.contactId === 'string' ? payload.contactId : undefined;
      const text = stripStationPrefix(rawText, station);
      const role = payload.role ?? crewRoleForReport(station, payload.domain);
      const entry: typeof entries[number] = { t: ev.t, role, station, priority, text, contactId };
      entries.push(entry);

      if (priority === 'flash') {
        alerts.hidden = false;
        alertList.appendChild(renderEntry(entry));
        alerts.scrollTop = alerts.scrollHeight;
      } else if (selectedTab !== 'all' && selectedTab !== role) {
        unread.set(role, (unread.get(role) ?? 0) + 1);
        updateUnread();
      }
      if (selectedTab === 'all' || selectedTab === role) added.push(renderEntry(entry));

      if (priority === 'flash') {
        playFlashBeep();
        const side = root.closest('#side');
        if (side instanceof HTMLElement) {
          side.classList.remove('flash-pulse');
          void side.offsetWidth;
          side.classList.add('flash-pulse');
          if (flashTimer !== null) clearTimeout(flashTimer);
          flashTimer = setTimeout(() => { side.classList.remove('flash-pulse'); flashTimer = null; }, 2800);
        }
      }
    }

    if (added.length > 0) {
      // Keep existing report buttons connected so incoming reports preserve focus.
      list.append(...added);
      list.scrollTop = list.scrollHeight;
    }
  }

  function destroy(): void {
    destroyed = true;
    if (flashTimer !== null) clearTimeout(flashTimer);
    root.closest('#side')?.classList.remove('flash-pulse');
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
