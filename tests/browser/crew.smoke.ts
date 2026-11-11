import { test, expect } from './harness';
import { installProbes } from './probes';

for (const size of ['standard', 'large'] as const) {
  test(`${size}: production crew component unread, keyboard roles, FLASH overflow and native audio`, async ({ page, smoke }, testInfo) => {
    await installProbes(page);
    await page.goto(`${smoke.url}/browser-fixture/index.html`);
    await page.locator('.text-size-control select').selectOption(size);
    const surface = page.getByRole('tab', { name: /^Surface Search/ });
    await expect(surface).toHaveAccessibleName('Surface Search, 1 unread');
    await expect(surface.locator('.crew-feed-unread')).toHaveText('1');
    await surface.click();
    await expect(surface).toHaveAttribute('aria-selected', 'true');
    await expect(surface.locator('.crew-feed-unread')).toBeHidden();
    const reportedContact = page.getByRole('button', { name: /^Select reported contact:/ });
    await reportedContact.focus();
    // An unsolicited production update must preserve the focused report button.
    // Programmatic activation adds fixture events without moving browser focus.
    await page.getByRole('button', { name: 'Append routine reports' }).evaluate((button) => {
      if (!(button instanceof HTMLButtonElement)) throw new Error('Expected the routine report fixture button');
      button.click();
    });
    await expect(page.locator('.crew-feed-list .crew-msg')).toHaveCount(3);
    await expect(reportedContact).toBeFocused();
    await expect(page.locator('#selection')).toBeEmpty();
    await page.keyboard.press('Enter');
    await expect(page.locator('#selection')).toHaveText('surface-proof');
    await surface.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Weapons Officer', exact: true })).toBeFocused();
    await expect(page.getByRole('tab', { name: 'Weapons Officer', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Air Search', exact: true }).click();
    await page.getByRole('button', { name: 'Append routine reports' }).click();
    await expect(surface).toHaveAccessibleName('Surface Search, 2 unread');
    await expect(page.getByRole('tab', { name: 'Weapons Officer', exact: true }).locator('.crew-feed-unread')).toBeHidden();
    await expect(page.getByRole('tab', { name: 'All, 2 unread' })).toBeVisible();
    await page.getByRole('tab', { name: 'All, 2 unread' }).click();
    await expect(surface.locator('.crew-feed-unread')).toBeHidden();
    await expect(page.getByRole('tab', { name: 'All', exact: true }).locator('.crew-feed-unread')).toBeHidden();
    await page.getByRole('tab', { name: 'Air Search', exact: true }).click();
    // Trusted Playwright clicks reach production gesture listeners; native WebAudio remains real.
    await expect.poll(() => page.evaluate(() => window.smokeProbe.contexts.map((context) => context.state))).toEqual(['running']);
    await page.getByRole('button', { name: 'Append FLASH reports' }).click();
    const alerts = page.getByRole('region', { name: 'Urgent crew alerts' });
    await expect(alerts).toBeVisible();
    await expect(alerts.locator('.crew-msg')).toHaveCount(12);
    const geometry = await alerts.evaluate((el) => {
      const newest = el.querySelector('.crew-msg:last-child')!.getBoundingClientRect();
      const bounds = el.getBoundingClientRect();
      return { top: el.scrollTop, height: el.clientHeight, total: el.scrollHeight, newestBottom: newest.bottom, bottom: bounds.bottom };
    });
    expect(geometry.total).toBeGreaterThan(geometry.height);
    expect(geometry.top + geometry.height).toBeGreaterThanOrEqual(geometry.total - 2);
    expect(geometry.newestBottom).toBeLessThanOrEqual(geometry.bottom + 1);
    await expect(alerts.locator('.crew-msg').last()).toContainText('urgent report 11');
    const audio = await page.evaluate(() => ({ starts: window.smokeProbe.oscillatorStarts, gestures: window.smokeProbe.trustedGestures }));
    expect(audio.gestures).toBeGreaterThan(0);
    expect(audio.starts).toBe(12);
    await testInfo.attach(`crew-flash-${size}`, { body: await page.screenshot(), contentType: 'image/png' });
    await page.getByRole('button', { name: 'Destroy feed' }).click();
    await expect(page.locator('#crew-feed')).toBeEmpty();
    await expect.poll(() => page.evaluate(() => window.smokeProbe.contexts.map((context) => context.state))).toEqual(['closed']);
    await page.getByRole('button', { name: 'Append FLASH reports' }).click();
    expect(await page.evaluate(() => window.smokeProbe.oscillatorStarts)).toBe(12);
  });
}
