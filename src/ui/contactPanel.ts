import type { Contact, OwnShip } from '../sim/types';
import { describeContact } from './contactSelection';

export interface ContactAction {
  id: string;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}

export interface ContactPanel {
  update(contact: Contact | null, ownShip: OwnShip): void;
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

  function update(contact: Contact | null, ownShip: OwnShip): void {
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

  function setActions(actions: readonly ContactAction[]): void {
    while (actionsContainer.firstChild) {
      actionsContainer.removeChild(actionsContainer.firstChild);
    }

    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      if (action.disabled) {
        button.disabled = true;
      }
      button.addEventListener('click', action.onClick);
      actionsContainer.appendChild(button);
    }
  }

  function destroy(): void {
    while (root.firstChild) {
      root.removeChild(root.firstChild);
    }
  }

  return { update, setActions, destroy };
}
