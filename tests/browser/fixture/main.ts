import '../../../src/styles.css';
import { createCrewFeed } from '../../../src/ui/crewFeed';
import { createTextSizeControl } from '../../../src/ui/textSize';
import type { GameEvent } from '../../../src/sim/types';

createTextSizeControl(document.querySelector<HTMLElement>('#topbar')!);
const feed = createCrewFeed(document.querySelector<HTMLElement>('#crew-feed')!, (id) => {
  document.querySelector('output')!.textContent = id;
});
const reports: GameEvent[] = [{
  type: 'crew-report', actor: 'crew-auto', t: 0,
  payload: { station: 'SWC', domain: 'surface', priority: 'routine', contactId: 'surface-proof', text: 'Sir, new surface contact bearing 090. I cannot identify it yet.' },
}];
feed.update(reports);
document.querySelector('#routine')!.addEventListener('click', () => {
  for (let n = 0; n < 2; n++) reports.push({
    type: 'crew-report', actor: 'crew-auto', t: n + 1,
    payload: { station: 'SWC', domain: 'surface', priority: 'routine', text: `Sir, surface routine report ${n}.` },
  });
  feed.update(reports);
  // Replaying the same event list must not count the reports twice.
  feed.update(reports);
});
document.querySelector('#append')!.addEventListener('click', () => {
  for (let n = 0; n < 12; n++) reports.push({
    type: 'crew-report', actor: 'crew-auto', t: n + 1,
    payload: { station: 'Bridge', role: 'weapons-officer', priority: 'flash', text: `Sir, urgent report ${n}. Incoming missile, prepare defenses immediately.` },
  });
  feed.update(reports);
});
document.querySelector('#destroy')!.addEventListener('click', () => feed.destroy());
