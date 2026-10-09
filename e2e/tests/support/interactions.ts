import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { API_URL } from '../../urls';
import { generationStub } from './cards';
import { clearGemini, expectGeminiMatching, expectGeminiPayload, userText } from './mockServer';

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
  // Phase 31. Matched on its own text: a save of an inflected form looks its
  // lemma up in the background, and a stub that answered every call would write
  // this word's entries under that lemma.
  await expectGeminiMatching(request, userText(text), payload);
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

/** Phase 27 Part B. Makes one list session and skips it unplayed, so the next
 *  is ordinal 1 (the rotation's step, D9). Past a skipped seed, with words saved. */
export async function skipListSession(request: APIRequestContext, enrollmentId: string) {
  await clearGemini(request);
  await expectGeminiPayload(request, generationStub());
  const made = await request.post(`${API_URL}/api/sessions`, { data: { enrollment_id: enrollmentId } });
  expect(made.ok(), await made.text()).toBe(true);
  const { session_id } = (await made.json()) as { session_id: string };
  expect((await request.post(`${API_URL}/api/sessions/${session_id}/skip`)).ok()).toBe(true);
}
