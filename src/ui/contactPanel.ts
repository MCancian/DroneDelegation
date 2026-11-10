import type { OwnShip, SensorTrack } from '../sim/types';
import { describeContact } from './contactSelection';

export interface ContactAction {
  id: string;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
  onClick: () => void;
}

export interface ContactPanel {
  update(contact: SensorTrack | null, ownShip: OwnShip): void;
  setActions(actions: readonly ContactAction[]): void;
  destroy(): void;
}

export function createContactPanel(root: HTMLElement): ContactPanel {
  const header = document.createElement('div');
  header.className = 'contact-header';
  header.textContent = 'No contact selected';

  const grid = document.createElement('div');
  grid.className = 'contact-grid';
  grid.style.display = 'none';

  const ROW_COUNT = 13;
  const labelCells: HTMLElement[] = [];
  const valueCells: HTMLElement[] = [];

  for (let i = 0; i < ROW_COUNT; i++) {
    const row = document.createElement('div');
    row.className = 'contact-row';

    const label = document.createElement('span');
    label.className = 'contact-label';

    const value = document.createElement('span');
    value.className = 'contact-value';

    row.appendChild(label);
    row.appendChild(value);
    grid.appendChild(row);

    labelCells.push(label);
    valueCells.push(value);
  }

  const actionsContainer = document.createElement('div');
  actionsContainer.className = 'contact-actions';

  root.appendChild(header);
  root.appendChild(grid);
  root.appendChild(actionsContainer);

  let lastKey = '';

  // Action memoization state
  let lastActionSignature = '';
  const callbackRefs = new Map<string, () => void>();
  const buttonRefs = new Map<string, HTMLButtonElement>();

  function update(contact: SensorTrack | null, ownShip: OwnShip): void {
    if (contact === null) {
      header.textContent = 'No contact selected';
      grid.style.display = 'none';
      root.removeAttribute('data-classification');
      lastKey = '';
      return;
    }

    const details = describeContact(contact, ownShip);
    const key =
      contact.trackId + '|' + contact.classification + '|' +
      details.rows.map((r) => r.value).join('|');

    if (key === lastKey) {
      return;
    }
    lastKey = key;

    header.textContent = contact.trackId + ' \u2014 ' + contact.classification.toUpperCase();
    root.setAttribute('data-classification', contact.classification);
    grid.style.display = '';

    for (let i = 0; i < ROW_COUNT; i++) {
      const row = details.rows[i];
      if (row !== undefined) {
        labelCells[i].textContent = row.label;
        valueCells[i].textContent = row.value;
      } else {
        labelCells[i].textContent = '';
        valueCells[i].textContent = '';
      }
    }
  }

  function computeSignature(actions: readonly ContactAction[]): string {
    return actions
      .map((a) => `${a.id}|${a.label}|${a.disabled ? 1 : 0}|${a.disabledReason ?? ''}`)
      .join(';');
  }

  function setActions(actions: readonly ContactAction[]): void {
    const signature = computeSignature(actions);

    if (signature === lastActionSignature) {
      // Same structure: update callbacks safely via stored refs
      for (const action of actions) {
        callbackRefs.set(action.id, action.onClick);
      }
      return;
    }

    lastActionSignature = signature;
    callbackRefs.clear();
    buttonRefs.clear();

    while (actionsContainer.firstChild) {
      actionsContainer.removeChild(actionsContainer.firstChild);
    }

    for (const action of actions) {
      callbackRefs.set(action.id, action.onClick);

      const wrapper = document.createElement('span');
      wrapper.style.display = 'inline-flex';
      wrapper.style.alignItems = 'center';
      wrapper.style.gap = '0.2rem';

      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.setAttribute('data-action', action.id);

      if (action.disabled) {
        button.disabled = true;
        if (action.disabledReason) {
          button.title = action.disabledReason;
        }
      }

      button.addEventListener('click', () => {
        const cb = callbackRefs.get(action.id);
        if (cb) cb();
      });

      buttonRefs.set(action.id, button);
      wrapper.appendChild(button);

      if (action.disabled && action.disabledReason) {
        const reasonLabel = document.createElement('span');
        reasonLabel.textContent = action.disabledReason;
        reasonLabel.style.fontSize = '0.6rem';
        reasonLabel.style.color = '#ff8800';
        reasonLabel.setAttribute('aria-hidden', 'true');
        wrapper.appendChild(reasonLabel);
      }

      actionsContainer.appendChild(wrapper);
    }
  }

  function destroy(): void {
    while (root.firstChild) {
      root.removeChild(root.firstChild);
    }
    callbackRefs.clear();
    buttonRefs.clear();
    lastActionSignature = '';
  }

  return { update, setActions, destroy };
}
