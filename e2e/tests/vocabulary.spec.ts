import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { clearGemini, expectGemini } from './support/mockServer';
import { createLearner, logIn } from './support/users';

test.setTimeout(180_000);

// Strings the seed does not contain, so each lookup reaches MockServer once and
// is written to the e2e database. The lexemes are new, so no reconciliation call.
const PROCHITALA = {
  kind: 'word' as const,
  entries: [
    {
      lemma: 'прочитать',
      part_of_speech: 'verb',
      senses: [
        { translation: 'קראה', sense_code: 'read_through' },
        { translation: 'הקריאה', sense_code: 'read_aloud' },
      ],
    },
  ],
};
const LUK = {
  kind: 'word' as const,
  entries: [
    {
      lemma: 'лук',
      part_of_speech: 'noun',
      senses: [
        { translation: 'בצל', sense_code: 'onion' },
        { translation: 'קשת', sense_code: 'bow' },
      ],
    },
  ],
};
const BATZAL = {
  kind: 'word' as const,
  entries: [{ lemma: 'בצל', part_of_speech: 'noun', senses: [{ translation: 'лук', sense_code: 'onion' }] }],
};

test.beforeEach(async ({ request }) => {
  await clearGemini(request);
});

// Retried: a static export serves markup before React hydrates, so an early click
// is a silent no-op (the pattern session.spec.ts and translate.spec.ts use).
async function tapUntil(page: Page, testId: string, visible: string) {
  await expect(async () => {
    await page.getByTestId(testId).click();
    await expect(page.getByTestId(visible).first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

async function lookUp(page: Page, request: APIRequestContext, text: string, payload: unknown) {
  await clearGemini(request);
  await expectGemini(request, payload as Parameters<typeof expectGemini>[1]);
  await page.getByTestId('translate-input').fill(text);
  await page.getByTestId('translate-submit').click();
  await expect(page.getByTestId('translate-sense').first()).toBeVisible();
}

// A toggle or save-all flips its label optimistically, so the label proves
// nothing about the write. Wait for the vocabulary POST/DELETE itself to
// answer before anything navigates or reloads the list; callers then also
// wait for the toggle to be enabled again (it is disabled while in flight).
async function tapAndWaitForWrite(page: Page, button: Locator) {
  const written = page.waitForResponse(
    (res) =>
      /\/api\/enrollments\/[^/]+\/vocabulary/.test(res.url()) &&
      (res.request().method() === 'POST' || res.request().method() === 'DELETE'),
  );
  await button.click();
  expect((await written).ok()).toBe(true);
}

test('a Russian learner saves senses, browses the list, and changes it from the drill-down', async ({
  page,
  request,
}) => {
  await createLearner(request, 'e2e_vocab_ru', 'ru');
  await logIn(page, 'e2e_vocab_ru');
  await tapUntil(page, 'translate-entry', 'translate-input');

  // One sense of прочитала.
  await lookUp(page, request, 'прочитала', PROCHITALA);
  const save = page.getByTestId('translate-save');
  await tapAndWaitForWrite(page, save.first());
  await expect(save.first()).toHaveText('נשמר ✓');
  await expect(save.first()).toBeEnabled();

  // Both senses of лук, in one tap.
  await page.getByTestId('translate-new-word').click();
  await lookUp(page, request, 'лук', LUK);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save-all'));
  await expect(save).toHaveText(['נשמר ✓', 'נשמר ✓']);
  await expect(page.getByTestId('translate-save-all')).toHaveCount(0);
  await expect(save.first()).toBeEnabled();
  await expect(save.last()).toBeEnabled();

  // A reverse lookup offers no save: its senses belong to the Hebrew lexeme.
  await page.getByTestId('translate-new-word').click();
  await page.getByTestId('translate-flip').click();
  await lookUp(page, request, 'בצל', BATZAL);
  await expect(save).toHaveCount(0);

  // The list: newest save first, and прочитать carries 1/2. The mark text is
  // wrapped in Unicode isolates, so match it with a regex.
  await page.getByTestId('translate-back').click();
  await tapUntil(page, 'vocabulary-entry', 'vocabulary-word');
  const words = page.getByTestId('vocabulary-word');
  await expect(words).toHaveCount(2);
  await expect(words.nth(0)).toContainText('лук');
  await expect(words.nth(1)).toContainText('прочитать');
  await expect(words.nth(1).getByTestId('vocabulary-mark')).toContainText(/1\/2/);
  await expect(words.nth(0).getByTestId('vocabulary-mark')).toContainText(/2\/2/);

  // Drill-down: save the second meaning, unsave the first.
  await words.nth(1).click();
  const senses = page.getByTestId('vocabulary-sense');
  const toggle = (index: number) => senses.nth(index).getByTestId('vocabulary-sense-save');
  await expect(senses).toHaveCount(2);
  await expect(senses.nth(0)).toContainText('קראה');
  await expect(toggle(0)).toHaveText('נשמר ✓');
  await tapAndWaitForWrite(page, toggle(1));
  await expect(toggle(1)).toHaveText('נשמר ✓');
  await expect(toggle(1)).toBeEnabled();
  await tapAndWaitForWrite(page, toggle(0));
  await expect(toggle(0)).toHaveText('שמור');
  await expect(toggle(0)).toBeEnabled();

  // Back on the list the counts agree: one of two saved, and прочитать moved to
  // the top, because its newest save is now the newest of all.
  await page.getByTestId('vocabulary-word-back').click();
  await expect(words.nth(0)).toContainText('прочитать');
  await expect(words.nth(0).getByTestId('vocabulary-mark')).toContainText(/1\/2/);
  await expect(words.nth(0)).toContainText('הקריאה');
});
