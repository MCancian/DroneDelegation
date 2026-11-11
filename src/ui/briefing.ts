/** Present the watch briefing before any game time elapses. */
export function showBriefing(onStart: () => void): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'briefing';
  dialog.setAttribute('aria-labelledby', 'briefing-title');
  dialog.innerHTML = `
    <div class="briefing-content">
      <span class="briefing-eyebrow">DDG KESTREL · WATCH BRIEFING</span>
      <h1 id="briefing-title" tabindex="-1">Take command with Jarvis</h1>
      <p>Jarvis is your AI tactical assistant aboard Kestrel. You decide how much authority to delegate: ask for advice, give direct orders, or allow the assistant to engage contacts.</p>
      <p>When Jarvis is online, use chat to ask “What should I do next?” or give an order such as “Deploy chaff”. Set its Air and Surface authority using the controls at the top of the display.</p>
      <h2>Strait transit</h2>
      <p>Guide Kestrel through a busy strait. Red territory lies to the northeast; a civil airway crosses to the north. Visibility is hazy and fishing traffic is common.</p>
      <h2>Your ship</h2>
      <p>You have 24 SAMs, 6 chaff loads, 40 gun bursts and 1,000 CIWS rounds. Point defense starts in MANUAL. Activate AUTO and deploy chaff in time: an incoming-missile warning may leave only seconds to react. Select a radar track to inspect it and issue orders.</p>
      <h2>Delegation of authority</h2>
      <dl>
        <dt>HOLD</dt><dd>The assistant advises; you decide.</dd>
        <dt>CONSENT</dt><dd>Approve or deny proposed engagements within 30 seconds.</dd>
        <dt>VETO</dt><dd>Engagements proceed after 10 seconds unless you cancel.</dd>
        <dt>WEAPONS FREE</dt><dd>The assistant can engage immediately.</dd>
      </dl>
      <p>Air and Surface authority start in HOLD and are set independently. Point defense is a separate AUTO/MANUAL control. Direct orders remain available at every level. Crew reports and doctrine continue if the AI is offline.</p>
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
  // Begin at the introduction even when larger text makes the briefing scroll.
  dialog.querySelector<HTMLElement>('#briefing-title')!.focus();
  dialog.scrollTop = 0;
}
