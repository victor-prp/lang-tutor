import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { clearGemini, expectGemini } from './mockServer';

// Retried: a static export serves markup before React hydrates, so an early
// click is a silent no-op (the pattern the specs share).
export async function tapUntil(page: Page, testId: string, visible: string) {
  await expect(async () => {
    await page.getByTestId(testId).click();
    await expect(page.getByTestId(visible).first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

export async function lookUp(page: Page, request: APIRequestContext, text: string, payload: unknown) {
  await clearGemini(request);
  await expectGemini(request, payload as Parameters<typeof expectGemini>[1]);
  await page.getByTestId('translate-input').fill(text);
  await page.getByTestId('translate-submit').click();
  await expect(page.getByTestId('translate-sense').first()).toBeVisible();
}

// Waits for the vocabulary POST itself: a save flips its label optimistically,
// so the label proves nothing about the write. POST only, deliberately:
// vocabulary.spec.ts also unsaves, so it keeps its own copy that waits for a
// DELETE as well.
export async function tapAndWaitForWrite(page: Page, button: Locator) {
  const written = page.waitForResponse(
    (res) => /\/api\/enrollments\/[^/]+\/vocabulary/.test(res.url()) && res.request().method() === 'POST',
  );
  await button.click();
  expect((await written).ok()).toBe(true);
}
