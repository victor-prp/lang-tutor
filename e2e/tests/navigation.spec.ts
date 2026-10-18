import { expect, test, type Page } from '@playwright/test';

import { expectGeneration } from './support/cards';
import { BOARD_WORDS } from './support/lexemes';
import { clearGemini } from './support/mockServer';
import { enrollmentIdOf } from './support/sessions';
import { lookUpEntries, saveEntries } from './support/targets';
import { openApp, signUpLearner } from './support/users';

// Phase 64 (spec D1, D2, D10). The bar's four tabs reach each other without home; the header's
// translate opens over the tab it was pressed on and returns to it; the bar is not there in a
// session; and the language switched from the header on מילים switches the list too.
test.setTimeout(150_000);
test.beforeEach(async ({ request }) => {
  await clearGemini(request);
});

async function startSession(page: Page) {
  await expect(async () => {
    await page.getByTestId('start-button').click();
    await expect(page.getByTestId('progress-label')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

test('the four tabs reach each other, translate returns to its tab, and a session has no bar', async ({ page }) => {
  await signUpLearner(page, 'e2e_tabs_walk', 'ru');
  await openApp(page);

  // Each tab from the one before, never through home.
  await page.getByTestId('vocabulary-entry').click();
  await expect(page.getByTestId('vocabulary-title')).toHaveText('המילים שלי');
  await page.getByTestId('profile-button').click();
  await expect(page.getByTestId('profile-username')).toHaveText('e2e_tabs_walk');
  await page.getByTestId('settings-tab').click();
  await expect(page.getByTestId('sign-out-button')).toBeVisible();
  await page.getByTestId('vocabulary-entry').click();
  await expect(page.getByTestId('vocabulary-title')).toBeVisible();
  await expect(page.getByTestId('vocabulary-entry')).toHaveAttribute('aria-selected', 'true');

  // Translate opens over מילים, with no bar, and its ✕ returns to מילים.
  await page.getByTestId('translate-entry').click();
  await expect(page.getByTestId('translate-input')).toBeVisible();
  await expect(page.getByTestId('settings-tab')).toBeHidden();
  await page.getByTestId('translate-back').click();
  await expect(page.getByTestId('vocabulary-title')).toBeVisible();
  await expect(page.getByTestId('vocabulary-entry')).toHaveAttribute('aria-selected', 'true');

  // A session covers the bar (Victor: "we want the learner to be focused").
  await page.getByTestId('tab-practice').click();
  await startSession(page);
  await expect(page.getByTestId('settings-tab')).toBeHidden();
  await page.getByTestId('session-back').click();
  await expect(page.getByTestId('settings-tab')).toBeVisible();
});

test('the language switched from the header on מילים switches the list with it', async ({ page, request }) => {
  await signUpLearner(page, 'e2e_tabs_switch', 'ru');
  const enrollmentId = await enrollmentIdOf(page.request);
  const [daisy] = await lookUpEntries(page.request, enrollmentId, BOARD_WORDS.slice(0, 1));
  await expectGeneration(request);
  await saveEntries(page.request, enrollmentId, daisy);
  await openApp(page, 'enrollment-switcher');

  // A second language, English, with nothing saved yet.
  await page.getByTestId('enrollment-switcher').click();
  await page.getByTestId('enrollment-add').click();
  await page.getByTestId('enroll-en').click();
  await page.getByTestId('enroll-submit').click();
  await expect(page.getByTestId('enrollment-switcher')).toHaveText('אנגלית ▾');

  await page.getByTestId('vocabulary-entry').click();
  await expect(page.getByTestId('vocabulary-empty')).toBeVisible();
  await page.getByTestId('enrollment-switcher').click();
  await page.getByTestId('enrollment-option-ru').click();
  await expect(page.getByTestId('enrollment-switcher')).toHaveText('רוסית ▾');
  await expect(page.getByTestId('vocabulary-word')).toHaveCount(1);
  await expect(page.getByTestId('vocabulary-word')).toContainText(BOARD_WORDS[0].form);
});
