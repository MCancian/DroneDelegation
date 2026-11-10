/** Present the watch briefing before any game time elapses. */
export function showBriefing(onStart: () => void): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'briefing';
  dialog.setAttribute('aria-labelledby', 'briefing-title');
  dialog.innerHTML = `
    <div class="briefing-content">
      <span class="briefing-eyebrow">DDG KESTREL · WATCH BRIEFING</span>
      <h1 id="briefing-title">Strait transit</h1>
      <p>Guide Kestrel through a busy strait. Red territory lies to the northeast; a civil airway crosses to the north. Visibility is hazy and fishing traffic is common.</p>
      <h2>Your ship</h2>
      <p>You have 24 SAMs, 6 chaff loads, 40 gun bursts and 1,000 CIWS rounds. Point defense starts in AUTO. Select a radar track to inspect it and issue orders.</p>
      <h2>Delegation of authority</h2>
      <dl>
        <dt>HOLD</dt><dd>The assistant advises; you decide.</dd>
        <dt>CONSENT</dt><dd>Approve or deny proposed engagements within 30 seconds.</dd>
        <dt>VETO</dt><dd>Engagements proceed after 10 seconds unless you cancel.</dd>
        <dt>WEAPONS FREE</dt><dd>The assistant can engage immediately.</dd>
      </dl>
      <p>Air and surface authority are set independently. Direct orders remain available at every level. Crew reports and doctrine continue if the AI is offline.</p>
      <p class="briefing-warning">Once you take the watch, the clock will not stop.</p>
      <button type="button" class="briefing-start">Take the watch</button>
    </div>`;
  document.body.appendChild(dialog);
  dialog.addEventListener('cancel', (event) => event.preventDefault());
  const start = dialog.querySelector<HTMLButtonElement>('.briefing-start')!;
  start.addEventListener('click', () => {
    dialog.close();
    dialog.remove();
    onStart();
  }, { once: true });
  dialog.showModal();
  start.focus();
}
