import { expect, test } from '@playwright/test';

import { API_URL } from '../urls';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { lookUp, tapAndWaitForWrite, tapUntil } from './support/interactions';
import { LUK, PROCHITALA } from './support/lexemes';
import { clearGemini, expectGeminiPayload } from './support/mockServer';
import { stripIsolates } from './support/text';
import { createLearner, logIn } from './support/users';

test.setTimeout(180_000);

const DIMENSIONS = ['written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling'];
const WRONG = ['דלת', 'קיר', 'תקרה'];
const DISTRACTORS = {
  items: Array.from({ length: 10 }, (_, i) => ({ key: `q${i + 1}`, distractors: WRONG })),
};

test('a session moves the words it practised up the ladder, and the list filters by level', async ({
  page,
  request,
}) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  page.on('dialog', (dialog) => void dialog.accept());

  await createLearner(request, 'e2e_progress_ru', 'ru');
  await logIn(page, 'e2e_progress_ru');

  // 1. Past the seed, with four saved senses of two words.
  await tapUntil(page, 'start-button', 'progress-label');
  await page.getByTestId('session-skip').click();
  await expect(page.getByTestId('save-words-first'), report()).toBeVisible();
  await tapUntil(page, 'translate-entry', 'translate-input');
  await lookUp(page, request, 'прочитала', PROCHITALA);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save-all'));
  await page.getByTestId('translate-new-word').click();
  await lookUp(page, request, 'лук', LUK);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save-all'));
  await page.getByTestId('translate-back').click();

  // 2. A list session: лук answered right, прочитала wrong.
  await clearGemini(request);
  await expectGeminiPayload(request, DISTRACTORS);
  await page.getByTestId('create-button').click();
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');
  for (let position = 1; position <= 4; position++) {
    await expect(page.getByTestId('progress-label')).toHaveText(new RegExp(`${position}\\s*/\\s*4`));
    const prompt = stripIsolates(await page.getByTestId('question-prompt').textContent());
    const options = await Promise.all(
      [0, 1, 2, 3].map(async (i) => stripIsolates(await page.getByTestId(`option-${i}`).textContent())),
    );
    const pick = prompt === 'лук' ? options.findIndex((text) => !WRONG.includes(text)) : options.indexOf(WRONG[0]);
    await page.getByTestId(`option-${pick}`).click();
    await page.getByTestId('continue-button').click();
  }

  // 3. Results: four practised words, the two лук senses moved up to נחשפה.
  await expect(page.getByTestId('practised-row')).toHaveCount(4);
  await expect(page.getByTestId('practised-raised')).toHaveCount(2);
  const raised = page.getByTestId('practised-row').filter({ has: page.getByTestId('practised-raised') });
  for (const row of await raised.all()) {
    await expect(row).toContainText('лук');
    await expect(row.getByTestId('practised-level-name')).toHaveText('נחשפה');
  }

  // 4. The list: лук at נחשפה, прочитать at חדשה.
  await page.getByTestId('results-done').click();
  await tapUntil(page, 'vocabulary-entry', 'vocabulary-word');
  const words = page.getByTestId('vocabulary-word');
  await expect(words).toHaveCount(2);
  await expect(words.filter({ hasText: 'лук' }).getByTestId('vocabulary-word-level-name')).toHaveText('נחשפה');
  await expect(words.filter({ hasText: 'прочитать' }).getByTestId('vocabulary-word-level-name')).toHaveText('חדשה');

  // 5. No sorts any more, and the filter opens on "all".
  await expect(page.locator('[data-testid^="vocabulary-sort-"]')).toHaveCount(0);
  await expect(page.getByTestId('vocabulary-level-all')).toBeVisible();

  // 6. Filter to a level, an empty level, and "all" to clear it.
  await page.getByTestId('vocabulary-level-2').click();
  await expect(words).toHaveCount(1);
  await expect(words.first()).toContainText('лук');
  await page.getByTestId('vocabulary-level-all').click();
  await expect(words).toHaveCount(2);
  await page.getByTestId('vocabulary-level-4').click();
  await expect(page.getByTestId('vocabulary-empty-level')).toBeVisible();
  await page.getByTestId('vocabulary-level-all').click();
  await expect(words).toHaveCount(2);

  // 7. A word's detail: five dimensions, one live.
  await words.filter({ hasText: 'лук' }).click();
  await expect(page.getByTestId('vocabulary-sense-level')).toHaveCount(2);
  // Each of the two saved senses shows all five dimensions, and one is live: the
  // other four read "not practised yet" (8 of 10).
  for (const dimension of DIMENSIONS) {
    await expect(page.getByTestId(`vocabulary-dimension-${dimension}`)).toHaveCount(2);
  }
  const dimensionRows = page.locator('[data-testid^="vocabulary-dimension-"]');
  await expect(dimensionRows).toHaveCount(10);
  await expect(page.getByTestId('vocabulary-dimension-written_receptive').first()).toContainText('נחשפה');
  await expect(page.getByTestId('vocabulary-dimension-spelling').first()).toContainText('טרם תורגל');
  await expect(dimensionRows.filter({ hasText: 'טרם תורגל' })).toHaveCount(8);

  expect(diagnostics.pageErrors, report()).toEqual([]);
});
