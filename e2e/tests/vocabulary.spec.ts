import { expect, test, type Locator, type Page } from '@playwright/test';

import { lookUp, tapUntil } from './support/interactions';
import { LUK, PROCHITALA, ZNAT } from './support/lexemes';
import { knownSeeds, seedMemory } from './support/memory';
import { clearGemini } from './support/mockServer';
import { openApp, signUpLearner } from './support/users';

test.setTimeout(180_000);

const BATZAL = {
  kind: 'word' as const,
  entries: [{ lemma: 'בצל', part_of_speech: 'noun', senses: [{ translation: 'лук', sense_code: 'onion' }] }],
};

test.beforeEach(async ({ request }) => {
  await clearGemini(request);
});

// A toggle or save-all flips its label optimistically, so the label proves
// nothing about the write. Wait for the vocabulary POST/DELETE itself to
// answer before anything navigates or reloads the list; callers then also
// wait for the toggle to be enabled again (it is disabled while in flight).
// Local, not in support/interactions.ts: that one waits for a POST only, and this
// spec also unsaves.
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
  await signUpLearner(page, 'e2e_vocab_ru', 'ru');
  await openApp(page);
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
  // Enabled first: the toggle stays disabled until the word is read again, so the
  // label is then checked against what the re-read left, and in the same row.
  await tapAndWaitForWrite(page, toggle(1));
  await expect(toggle(1)).toBeEnabled();
  await expect(toggle(1)).toHaveText('נשמר ✓');
  await tapAndWaitForWrite(page, toggle(0));
  await expect(toggle(0)).toBeEnabled();
  await expect(toggle(0)).toHaveText('שמור');

  // Back on the list the counts agree: one of two saved, and прочитать moved to
  // the top, because its newest save is now the newest of all.
  await page.getByTestId('vocabulary-word-back').click();
  await expect(words.nth(0)).toContainText('прочитать');
  await expect(words.nth(0).getByTestId('vocabulary-mark')).toContainText(/1\/2/);
  await expect(words.nth(0)).toContainText('הקריאה');
});

test('a word saved in two parts of speech is one row, and its detail labels each sense', async ({
  page,
  request,
}) => {
  await signUpLearner(page, 'e2e_vocab_merge_ru', 'ru');
  await openApp(page);
  await tapUntil(page, 'translate-entry', 'translate-input');

  // Both lexemes of знать, in one tap.
  await lookUp(page, request, 'знать', ZNAT);
  const save = page.getByTestId('translate-save');
  await expect(save).toHaveCount(2);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save-all'));
  await expect(save).toHaveText(['נשמר ✓', 'נשמר ✓']);

  // One row, both saved senses counted, both parts of speech named.
  await page.getByTestId('translate-back').click();
  await tapUntil(page, 'vocabulary-entry', 'vocabulary-word');
  const words = page.getByTestId('vocabulary-word');
  await expect(words).toHaveCount(1);
  await expect(words.first()).toContainText('знать');
  await expect(words.first()).toContainText('שם עצם · פועל');
  await expect(words.first().getByTestId('vocabulary-mark')).toContainText(/2\/2/);

  // The detail: two cards, saved first and then by part of speech, so the noun
  // comes first. Each names its part of speech.
  await words.first().click();
  const senses = page.getByTestId('vocabulary-sense');
  await expect(senses).toHaveCount(2);
  await expect(senses.nth(0).getByTestId('vocabulary-sense-pos')).toHaveText('שם עצם');
  await expect(senses.nth(0)).toContainText('אצולה');
  await expect(senses.nth(1).getByTestId('vocabulary-sense-pos')).toHaveText('פועל');
  await expect(senses.nth(1)).toContainText('לדעת');

  // Unsave the noun. The row stays, now one of two, naming only the verb.
  const toggle = senses.nth(0).getByTestId('vocabulary-sense-save');
  await tapAndWaitForWrite(page, toggle);
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveText('שמור');
  await page.getByTestId('vocabulary-word-back').click();
  await expect(words).toHaveCount(1);
  await expect(words.first().getByTestId('vocabulary-mark')).toContainText(/1\/2/);
  await expect(words.first()).toContainText('פועל');
  await expect(words.first()).not.toContainText('שם עצם');
});

// Phase 58 (spec D4, D6), 58b (R2). прочитать and знать are new; лук, both its
// senses seeded to 2 in every skill, is not. The trash icon on each filter asks,
// naming the filter's words, and removes them in one call: a level's here, then
// every word on "all".
test('a learner removes the words of a level, then every word, with the trash icon', async ({ page, request }) => {
  await signUpLearner(page, 'e2e_vocab_remove_ru', 'ru');
  await openApp(page);
  await tapUntil(page, 'translate-entry', 'translate-input');
  for (const [text, lexeme] of [
    ['прочитала', PROCHITALA],
    ['знать', ZNAT],
    ['лук', LUK],
  ] as const) {
    await lookUp(page, request, text, lexeme);
    await tapAndWaitForWrite(page, page.getByTestId('translate-save-all'));
    await expect(page.getByTestId('translate-save-all')).toHaveCount(0);
    await page.getByTestId('translate-new-word').click();
  }
  await seedMemory(
    'e2e_vocab_remove_ru',
    [...knownSeeds('בצל'), ...knownSeeds('קשת')].map((seed) => ({ ...seed, level: 2 })),
  );

  await page.getByTestId('translate-back').click();
  await tapUntil(page, 'vocabulary-entry', 'vocabulary-word');
  const words = page.getByTestId('vocabulary-word');
  const remove = page.getByTestId('vocabulary-remove');
  await expect(words).toHaveCount(3);
  await expect(remove).toBeVisible();

  const removals: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'DELETE' && /\/vocabulary\?/.test(req.url())) removals.push(new URL(req.url()).search);
  });
  // The question is read after the dialog is answered: an assertion inside the
  // handler would leave it open and fail by timeout, not by the assertion.
  async function answer(accept: boolean): Promise<string> {
    const asked = page.waitForEvent('dialog').then(async (dialog) => {
      const message = dialog.message();
      await (accept ? dialog.accept() : dialog.dismiss());
      return message;
    });
    await remove.click();
    return asked;
  }

  // New: declined, nothing goes.
  await page.getByTestId('vocabulary-level-1').click();
  await expect(words).toHaveCount(2);
  expect(await answer(false)).toContain('להסיר את כל המילים ברמה "חדשה"?');
  await expect(words).toHaveCount(2);
  expect(removals).toEqual([]);

  // נחשפה: лук alone goes, and the filter is empty.
  await page.getByTestId('vocabulary-level-2').click();
  await expect(words).toHaveCount(1);
  let answered = page.waitForResponse((res) => res.request().method() === 'DELETE' && /\?level=2$/.test(res.url()));
  expect(await answer(true)).toContain('להסיר את כל המילים ברמה "נחשפה"?');
  expect(await (await answered).json()).toEqual({ removed_words: 1, removed_glosses: 2 });
  await expect(page.getByTestId('vocabulary-empty-level')).toBeVisible();
  await expect(remove).toHaveCount(0);

  // All: the two new words go, and the list is empty.
  await page.getByTestId('vocabulary-level-all').click();
  await expect(words).toHaveCount(2);
  answered = page.waitForResponse((res) => res.request().method() === 'DELETE' && /\?all=true$/.test(res.url()));
  expect(await answer(true)).toContain('להסיר את כל המילים ברשימה?');
  expect(await (await answered).json()).toEqual({ removed_words: 2, removed_glosses: 4 });
  await expect(page.getByTestId('vocabulary-empty')).toBeVisible();
  await expect(remove).toHaveCount(0);
  expect(removals).toEqual(['?level=2', '?all=true']);
});
