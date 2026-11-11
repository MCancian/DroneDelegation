import { test, expect } from './harness';
import { installProbes, render, startWatch } from './probes';
import { chatMessageCount, requireChatSuccess } from './chatOutcome';

for (const size of ['standard', 'large'] as const) {
  test(`${size}: briefing, layout, radar/report selection, manual command and persistence`, async ({ page, smoke }, testInfo) => {
    await installProbes(page);
    if (size === 'large') await page.addInitScript(() => {
      if (!localStorage.getItem('drone-delegation.text-size')) localStorage.setItem('drone-delegation.text-size', 'large');
    });
    await startWatch(page, smoke.url);
    const briefing = page.locator('.briefing');
    expect(await briefing.evaluate((el) => el.scrollTop)).toBe(0);
    const heading = page.getByRole('heading', { name: 'Take command with Jarvis' });
    const intro = await heading.boundingBox();
    expect(intro).not.toBeNull();
    expect(intro!.y).toBeGreaterThanOrEqual(0);
    expect(intro!.y + intro!.height).toBeLessThanOrEqual(720);
    await testInfo.attach(`briefing-${size}`, { body: await page.screenshot(), contentType: 'image/png' });
    await expect(page.locator('#clock')).toHaveText('00:00 / 15:00');
    const takeWatch = page.getByRole('button', { name: 'Take the watch' });
    await takeWatch.scrollIntoViewIfNeeded();
    await expect(takeWatch).toBeInViewport();
    await takeWatch.click();
    await page.clock.runFor(1_200);
    await expect(briefing).toHaveCount(0);
    await expect(page.locator('#clock')).toHaveText('00:01 / 15:00');
    const geometry = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      bodyFont: getComputedStyle(document.body).fontSize,
      feedFont: getComputedStyle(document.querySelector('.crew-msg')!).fontSize,
      radarFont: document.querySelector('canvas')!.getContext('2d')!.font,
      panels: ['#topbar', '#radar', '#side', '#crew-feed', '#chat', '.crew-feed-list', '.chat-messages'].map((selector) => {
        const r = document.querySelector(selector)!.getBoundingClientRect();
        return { selector, x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      }),
      outside: [...document.querySelectorAll<HTMLElement>('#topbar button,#topbar input,#topbar select,#range-buttons button,.crew-feed-tab,.chat-input,.chat-send-btn')]
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width && r.height && (r.left < 0 || r.top < 0 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1); })
        .map((el) => el.outerHTML),
    }));
    expect(geometry.width).toBe(1280);
    expect(geometry.outside).toEqual([]);
    for (const panel of geometry.panels) {
      expect(panel.width, `${panel.selector} has width`).toBeGreaterThan(0);
      expect(panel.height, `${panel.selector} has height`).toBeGreaterThan(0);
      expect(panel.x, `${panel.selector} left edge`).toBeGreaterThanOrEqual(0);
      expect(panel.y, `${panel.selector} top edge`).toBeGreaterThanOrEqual(0);
      expect(panel.right, `${panel.selector} right edge`).toBeLessThanOrEqual(1281);
      expect(panel.bottom, `${panel.selector} bottom edge`).toBeLessThanOrEqual(721);
    }
    expect(geometry.bodyFont).toBe(size === 'large' ? '18px' : '16px');
    expect(geometry.feedFont).toBe(size === 'large' ? '18px' : '16px');
    expect(geometry.radarFont).toMatch(new RegExp(`^${size === 'large' ? 16 : 14}px `));
    await testInfo.attach(`watch-${size}`, { body: await page.screenshot(), contentType: 'image/png' });

    // Select a real contact by clicking the center of a symbol drawn by production radar.
    const point = await page.evaluate(() => window.smokeProbe.arcs.find((arc) => arc.radius === 7));
    expect(point, 'a radar contact symbol is rendered').toBeDefined();
    await page.locator('#radar-canvas').click({ position: { x: point!.x, y: point!.y } });
    await render(page);
    await expect(page.locator('.contact-header')).not.toHaveText('No contact selected');
    await page.keyboard.press('Escape');
    await render(page);
    await expect(page.locator('.contact-header')).toHaveText('No contact selected');
    await page.getByRole('tab', { name: /^All/ }).click();
    await page.locator('.crew-feed-list .crew-select-btn').first().click();
    await render(page);
    await expect(page.locator('.contact-header')).not.toHaveText('No contact selected');
    await page.locator('[data-action="classify_friendly"]').click();
    await render(page);
    await expect(page.locator('#contact-panel')).toHaveAttribute('data-classification', 'friendly');
    await expect(page.locator('.contact-header')).toContainText('FRIENDLY');
    await page.locator('#point-defense-toggle').click();
    await render(page);
    await expect(page.locator('#point-defense-toggle')).toHaveText('PD: AUTO');

    // Switch via the real control, then reload to prove persistence without reseeding storage.
    const other = size === 'standard' ? 'large' : 'standard';
    await page.locator('.text-size-control select').selectOption(other);
    await render(page);
    await page.reload();
    await expect(page.locator('.text-size-control select')).toHaveValue(other);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe(other === 'large' ? '18px' : '16px');
    expect(await page.locator('.briefing').evaluate((el) => el.scrollTop)).toBe(0);
  });
}

test('chat passes the real proxy/template, executes a direct order, reports early error, and cancels without execution', async ({ page, smoke }, testInfo) => {
  await startWatch(page, smoke.url);
  await page.getByRole('button', { name: 'Take the watch' }).click();
  await render(page);
  await expect(page.getByRole('status', { name: 'AI connection status' })).toHaveText('ONLINE');
  const input = page.getByRole('textbox', { name: 'Chat message input' });
  const chat = page.locator('.chat-messages');
  smoke.plans.push({ kind: 'success', content: 'Point defense set.\n```action\n{"action":"set_point_defense","mode":"auto"}\n```' });
  const beforeSuccess = await chatMessageCount(page);
  await input.fill('Set point defense to auto');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await requireChatSuccess(page, beforeSuccess, 'Executed: set_point_defense');
  await render(page);
  await expect(page.locator('#point-defense-toggle')).toHaveText('PD: AUTO');
  expect(smoke.requests).toHaveLength(1);
  expect(smoke.requests[0].messages.filter((message) => message.role === 'system')).toHaveLength(1);
  expect(smoke.requests[0].messages[0].content).toContain('\n\n');
  expect(smoke.requests[0].messages[0].content).toContain('OWN: pos(');
  expect(smoke.requests[0].messages[0].content).toContain('TRACKS:');
  expect(smoke.requests[0].messages.at(-1)?.content).toBe('Set point defense to auto');
  expect(smoke.requests[0].templateError).toBeUndefined();

  smoke.plans.push({ kind: 'error' });
  const errorStarted = Date.now();
  const beforeError = await chatMessageCount(page);
  await input.fill('Report status');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  // A local diagnostic must arrive within 5s, before the 15s proxy / 30s test timeout.
  await expect(requireChatSuccess(page, beforeError, 'Status reported.')).rejects.toThrow('Error: Upstream returned 503');
  expect(Date.now() - errorStarted).toBeLessThan(5_000);
  await expect(input).toBeEnabled();

  smoke.plans.push({ kind: 'hold', content: 'Switching now.\n```action\n{"action":"set_point_defense","mode":"manual"}\n```' });
  await input.fill('Set point defense to manual');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.chat-streaming')).toContainText('Switching now.');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(chat).toContainText('Response cancelled.');
  await expect.poll(() => smoke.requests.at(-1)?.closed, { message: 'browser abort reaches fake upstream' }).toBe(true);
  await render(page);
  await expect(page.locator('#point-defense-toggle')).toHaveText('PD: AUTO');
  await expect(chat.locator('.chat-msg-system').filter({ hasText: 'Executed: set_point_defense' })).toHaveCount(1);
  await expect(page.locator('.chat-streaming')).toHaveCount(0);
  await expect(input).toBeEnabled();
  await testInfo.attach('chat-error-and-cancellation', { body: await page.screenshot(), contentType: 'image/png' });

  // A subsequent request must acquire the same single slot after cancellation.
  smoke.plans.push({ kind: 'success', content: 'Recovered after cancellation.' });
  const beforeRecovery = await chatMessageCount(page);
  await input.fill('Report readiness');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await requireChatSuccess(page, beforeRecovery, 'Recovered after cancellation.');
  expect(smoke.requests).toHaveLength(4);
});
