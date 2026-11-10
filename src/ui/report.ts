import type { AarDecision, AarModel } from '../report/analyze';

export type DebriefStream = (model: AarModel, onDelta: (text: string) => void, signal?: AbortSignal) => Promise<void>;
export interface ReportOptions { debrief?: DebriefStream; onReplay?: () => void; }
export interface ReportView { element: HTMLElement; destroy(): void; }

function time(t: number): string {
  const s = Math.max(0, Math.round(t));
  return `T+${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function decisionText(d: AarDecision): string {
  const target = d.trackId ?? d.targetId;
  return `${time(d.t)} · ${d.actor} · ${d.action}${target ? ` ${target}` : ''}${d.autonomy ? ` · ${d.domain} ${d.autonomy}` : ''}${d.pointDefense ? ` · point defense ${d.pointDefense.toUpperCase()}` : ''}${d.rangeNm !== null ? ` · ${d.rangeNm.toFixed(1)} nm` : ''}${!d.ok ? ` · rejected${d.error ? `: ${d.error}` : ''}` : !d.executed ? ' · weapon fire not recorded' : ''}`;
}

export function createReport(model: AarModel, options: ReportOptions = {}): ReportView {
  const abort = new AbortController();
  let destroyed = false;
  const app = document.getElementById('app');
  const wasInert = app?.inert ?? false;
  if (app) app.inert = true;
  const overlay = node('section', 'report-overlay');
  overlay.id = 'after-action-report';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'report-title');
  overlay.tabIndex = -1;
  const content = node('div', 'report-content');
  const header = node('header', 'report-header');
  header.append(node('p', 'report-eyebrow', 'AFTER-ACTION REPORT'));
  const title = node('h1', 'report-title', model.verdict);
  title.id = 'report-title';
  header.append(title, node('p', 'report-subtitle', `${model.scenarioName} · ${time(model.endedAtS)} · Seed ${model.seed}`));
  content.append(header);
  const summary = node('section', 'report-summary');
  summary.setAttribute('aria-label', 'Outcome summary');
  for (const [label, value] of [
    ['Hull', `${Math.round(model.summary.hullPct)}%`], ['Missiles inbound', String(model.summary.missilesInbound)],
    ['Missiles hit', String(model.summary.missilesHit)], ['Missiles defeated', String(model.summary.missilesDefeated)],
    ['Missiles unresolved', String(model.summary.missilesUnresolved)], ['Hostiles neutralized', String(model.summary.hostilesNeutralized)],
    ['Civilian lives lost', String(model.summary.civilianLivesLost)],
  ]) {
    const tile = node('div', 'report-tile');
    tile.append(node('span', 'report-tile-value', value), node('span', 'report-tile-label', label));
    summary.append(tile);
  }
  content.append(summary);
  const keySection = node('section', 'report-key-events');
  keySection.append(node('h2', '', 'Key events'));
  const cards = node('div', 'report-cards');
  for (const key of model.keyEvents) {
    const card = node('article', 'report-card');
    card.append(node('h3', '', key.title), node('p', 'report-outcome', key.outcome));
    card.append(node('h4', '', 'Decisions'));
    if (!key.decisions.length) card.append(node('p', 'report-muted', 'No engagement decision recorded.'));
    else for (const decision of key.decisions) card.append(node('p', 'report-decision', decisionText(decision)));
    card.append(node('h4', '', 'Information and timing'));
    for (const info of key.information) card.append(node('p', 'report-info', `${info.t === null ? '' : `${time(info.t)} · `}${info.text}`));
    card.append(node('h4', '', 'Lesson'), node('p', 'report-lesson', key.lesson));
    cards.append(card);
  }
  keySection.append(cards);
  content.append(keySection);
  const timeline = node('section', 'report-timeline');
  timeline.append(node('h2', '', 'Authority and engagements'));
  for (const domain of ['air', 'surface'] as const) {
    const row = node('div', 'report-timeline-row');
    row.append(node('h3', '', domain === 'air' ? 'Air' : 'Surface'));
    const strip = node('div', 'report-timeline-strip');
    const entries = model.autonomyTimeline.filter(e => e.domain === domain);
    const end = Math.max(model.endedAtS, 0.1);
    entries.forEach((entry, i) => {
      const stop = entries[i + 1]?.t ?? end;
      const segment = node('span', `report-timeline-segment level-${entry.level.toLowerCase().replace('_', '-')}`, entry.level.replace('_', ' '));
      segment.style.flexGrow = String(Math.max(0.01, stop - entry.t));
      segment.title = `${time(entry.t)}: ${entry.level}`;
      strip.append(segment);
    });
    row.append(strip);
    const marks = model.engagements.filter(e => e.domain === domain);
    row.append(node('p', 'report-timeline-markers', marks.length
      ? marks.map(e => `◆ ${time(e.t)} ${e.trackId} (${e.actor})`).join('  ·  ')
      : 'No engagements recorded.'));
    timeline.append(row);
  }
  content.append(timeline);
  const log = node('details', 'report-log');
  log.append(node('summary', '', `Decision log (${model.decisions.length})`));
  const list = node('ol', 'report-decision-list');
  if (model.decisions.length === 0) list.append(node('li', 'report-muted', 'No decisions recorded.'));
  for (const decision of model.decisions) list.append(node('li', '', decisionText(decision)));
  log.append(list); content.append(log);
  const actions = node('div', 'report-actions');
  const replay = node('button', 'report-replay', 'Play again'); replay.type = 'button';
  replay.addEventListener('click', () => { destroy(); options.onReplay?.(); });
  actions.append(replay); content.append(actions);
  overlay.append(content); document.body.append(overlay); overlay.focus();

  const onPageHide = (): void => { destroy(); };
  window.addEventListener('pagehide', onPageHide, { once: true });
  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    abort.abort(); window.removeEventListener('pagehide', onPageHide);
    overlay.remove(); if (app) app.inert = wasInert;
  }
  if (options.debrief) {
    const section = node('section', 'report-debrief');
    const body = node('p', 'report-debrief-text');
    section.append(node('h2', '', 'AI debrief'), body);
    void Promise.resolve().then(() => options.debrief!(model, delta => {
      if (destroyed || abort.signal.aborted || !delta) return;
      if (!section.isConnected) content.insertBefore(section, actions);
      body.textContent += delta;
    }, abort.signal)).then(() => {
      if (!body.textContent?.trim()) section.remove();
    }).catch(() => { section.remove(); });
  }
  return { element: overlay, destroy };
}
