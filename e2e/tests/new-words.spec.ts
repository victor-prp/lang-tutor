import type { NewWordLimits, SessionView } from '@lang-tutor/core/api';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { expectGeneration } from './support/cards';
import { BOARD_WORDS } from './support/lexemes';
import { clearGemini } from './support/mockServer';
import { answerSessionRight, enrollmentIdOf, readyListSession, readyPathSession, skipSeed } from './support/sessions';
import { lookUpEntries, saveEntries } from './support/targets';
import { openApp, signUpLearner } from './support/users';
import { withVoices } from './support/voices';

// Phase 70 (spec D6, D7). The learner's new-word limits in הגדרות, and the message a session the
// day's cap held its new words back from opens with: once, until "אל תציג לי את זה שוב", and back
// on from the screen's switch.
test.setTimeout(240_000);
test.beforeEach(async ({ request }) => {
  await clearGemini(request);
});

async function readLimits(request: APIRequestContext): Promise<NewWordLimits> {
  const res = await request.get(`${API_URL}/api/me/new-words`);
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as NewWordLimits;
}

async function openNewWords(page: Page) {
  await page.getByTestId('settings-tab').click();
  await page.getByTestId('settings-new-words').click();
  await expect(page.getByTestId('new-words-day-15')).toBeVisible();
}

test('the new-word limits save from הגדרות, and read back', async ({ page }) => {
  await signUpLearner(page, 'e2e_new_words_save', 'ru');
  await openApp(page, 'settings-tab');
  await openNewWords(page);
  // A learner who never chose: 15 a day, automatic per session.
  await expect(page.getByTestId('new-words-day-15')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('new-words-session-auto')).toHaveAttribute('aria-selected', 'true');

  await page.getByTestId('new-words-day-30').click();
  await page.getByTestId('new-words-session-2').click();
  await expect(page.getByTestId('new-words-day-30')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('new-words-session-2')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => readLimits(page.request)).toEqual({ day_cap: 30, per_session: 2 });

  // Opened again from a fresh load: what was stored.
  await openApp(page, 'settings-tab');
  await openNewWords(page);
  await expect(page.getByTestId('new-words-day-30')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('new-words-session-2')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('new-words-day-15')).toHaveAttribute('aria-selected', 'false');
});

test('a session the cap held words back from says so; the tick keeps it closed, the switch brings it back', async ({
  page,
  request,
}) => {
  await withVoices(page, []);
  await signUpLearner(page, 'e2e_new_words_cap', 'ru');
  const enrollmentId = await enrollmentIdOf(page.request);
  await skipSeed(page.request, enrollmentId);
  // A cap of one new word a day, set before any word is saved.
  const put = await page.request.put(`${API_URL}/api/me/new-words`, { data: { day_cap: 1, per_session: null } });
  expect(put.ok(), await put.text()).toBe(true);
  const entries = await lookUpEntries(page.request, enrollmentId, BOARD_WORDS.slice(0, 3));
  await expectGeneration(request);
  await saveEntries(page.request, enrollmentId, entries.flat());

  // The first session meets the one word the cap allows; the next is chosen with it met.
  const first = await readyListSession(page.request, enrollmentId);
  await answerSessionRight(page.request, first.id);
  const heldId = await readyPathSession(page.request, enrollmentId);
  const view = (await (await page.request.get(`${API_URL}/api/sessions/${heldId}`)).json()) as SessionView;
  expect(view.held_new_words, JSON.stringify(view)).toEqual({ count: 2, day_cap: 1 });

  const sheet = page.getByTestId('cap-notice-sheet');
  const tick = page.getByTestId('cap-notice-stop');
  const enter = async () => {
    await page.getByTestId('start-button').click();
    await expect(page.getByTestId('progress-label')).toBeVisible();
  };
  // Nothing opens it after the screen decided: its store answers at once.
  const settled = () => page.waitForTimeout(1_500);

  // 1. Starting it opens the message over the first card, with the cap.
  await openApp(page);
  await enter();
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('הגעת למכסת המילים החדשות');
  await expect(sheet).toContainText('1');
  await expect(tick).toHaveAttribute('aria-checked', 'false');

  // 2. The tick and "המשך": it closes, and the session goes on.
  await tick.click();
  await expect(tick).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('cap-notice-continue').click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId('progress-label')).toBeVisible();

  // 3. Back home and in again, still before any answer: it stays closed.
  await page.getByTestId('session-back').click();
  await enter();
  await settled();
  await expect(sheet).toHaveCount(0);

  // 4. The screen's switch reads it off; turned on, the session opens with it again.
  await page.getByTestId('session-back').click();
  await openNewWords(page);
  const notice = page.getByTestId('new-words-notice').getByRole('switch');
  await expect(notice).not.toBeChecked();
  await notice.click();
  await expect(notice).toBeChecked();
  await page.getByTestId('new-words-back').click();
  await page.getByTestId('tab-home').click();
  await enter();
  await expect(sheet).toBeVisible();
});
