import { expect, type Page } from '@playwright/test';

export async function chatMessageCount(page: Page): Promise<number> {
  return page.locator('.chat-msg:not(.chat-streaming)').count();
}

/** Race the expected disposition against new visible errors, scoped to this send. */
export async function requireChatSuccess(page: Page, after: number, successText: string): Promise<void> {
  let outcome = '';
  await expect.poll(async () => {
    const current = (await page.locator('.chat-msg:not(.chat-streaming)').allTextContents()).slice(after);
    const error = current.find((text) => /Error:|Response cancelled\.|Failed:/.test(text));
    outcome = error ? `error: ${error}` : current.some((text) => text.includes(successText)) ? 'success' : '';
    return outcome;
  }, { timeout: 5_000, message: `chat outcome: ${successText}` }).not.toBe('');
  if (outcome !== 'success') throw new Error(`Chat request failed promptly: ${outcome}`);
}
