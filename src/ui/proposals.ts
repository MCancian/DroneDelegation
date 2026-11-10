import type { Proposal, ProposalManager } from '../ai/proposals';

export interface ProposalPanel { update(): void; destroy(): void }

/** Keep action elements stable while the game-time countdown changes. */
export function createProposals(root: HTMLElement, manager: ProposalManager, isEnded: () => boolean = () => false): ProposalPanel {
  const container = document.createElement('div');
  container.className = 'proposals';
  container.setAttribute('aria-live', 'polite');
  const inputRow = root.querySelector('.chat-input-row');
  if (inputRow?.parentNode === root) root.insertBefore(container, inputRow);
  else root.appendChild(container);
  const cards = new Map<string, { element: HTMLElement; timer: HTMLElement }>();

  function makeCard(p: Proposal): { element: HTMLElement; timer: HTMLElement } {
    const element = document.createElement('article');
    element.className = `proposal-card${p.level === 'VETO' ? ' proposal-veto' : ''}`;
    element.dataset.proposalId = p.id;
    const target = 'target' in p.command ? p.command.target : undefined;
    const track = target ? manager.world.visibleTracks().find((t) => t.id === target) : undefined;
    const title = document.createElement('strong');
    title.textContent = `${p.actor === 'doctrine' ? 'Doctrine' : 'AI'} proposes ${p.command.action} ${track?.trackId ?? ''}`;
    element.appendChild(title);
    if (p.reason) { const reason = document.createElement('p'); reason.textContent = p.reason; element.appendChild(reason); }
    const timer = document.createElement('span');
    timer.className = 'proposal-timer'; element.appendChild(timer);
    const buttons = document.createElement('div'); buttons.className = 'proposal-actions';
    const addButton = (label: string, click: () => void): void => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.addEventListener('click', () => { if (!isEnded()) { click(); update(); } }); buttons.appendChild(button);
    };
    if (p.level === 'CONSENT') { addButton('Approve', () => manager.approve(p.id)); addButton('Deny', () => manager.deny(p.id)); }
    else addButton('Cancel', () => manager.veto(p.id));
    element.appendChild(buttons); container.appendChild(element);
    return { element, timer };
  }

  function update(): void {
    const active = isEnded() ? [] : manager.list().filter((p) => p.status === 'pending');
    const ids = new Set(active.map((p) => p.id));
    for (const [id, card] of cards) if (!ids.has(id)) { card.element.remove(); cards.delete(id); }
    for (const p of active) {
      let card = cards.get(p.id);
      if (!card) { card = makeCard(p); cards.set(p.id, card); }
      const remaining = Math.max(0, Math.ceil((p.expiresAt ?? manager.world.time) - manager.world.time));
      card.timer.textContent = p.level === 'VETO' ? `Executes in ${remaining}s` : `Expires in ${remaining}s`;
    }
    container.hidden = active.length === 0;
  }
  update();
  return { update, destroy() { cards.clear(); container.remove(); } };
}
