import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { clearGemini, expectGemini, expectGeminiPayload } from './support/mockServer';
import { stripIsolates } from './support/text';
import { createLearner, logIn } from './support/users';

test.setTimeout(180_000);

// The same new lexemes next-session.spec.ts uses: four senses, two words.
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
const WRONG = ['דלת', 'קיר', 'תקרה'];
const DISTRACTORS = {
  items: Array.from({ length: 10 }, (_, i) => ({ key: `q${i + 1}`, distractors: WRONG })),
};

// Retried: a static export serves markup before React hydrates, so an early
// click is a silent no-op (the pattern the other specs use).
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

async function tapAndWaitForWrite(page: Page, button: Locator) {
  const written = page.waitForResponse(
    (res) => /\/api\/enrollments\/[^/]+\/vocabulary/.test(res.url()) && res.request().method() === 'POST',
  );
  await button.click();
  expect((await written).ok()).toBe(true);
}

test('a session moves the words it practised up the ladder, and the list sorts and filters by level', async ({
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

  // 5. Sort both ways.
  await page.getByTestId('vocabulary-sort-level_desc').click();
  await expect(words.first()).toContainText('лук');
  await page.getByTestId('vocabulary-sort-level_asc').click();
  await expect(words.first()).toContainText('прочитать');

  // 6. Filter, an empty level, and clearing it.
  await page.getByTestId('vocabulary-level-2').click();
  await expect(words).toHaveCount(1);
  await expect(words.first()).toContainText('лук');
  await page.getByTestId('vocabulary-level-2').click();
  await expect(words).toHaveCount(2);
  await page.getByTestId('vocabulary-level-4').click();
  await expect(page.getByTestId('vocabulary-empty-level')).toBeVisible();
  await page.getByTestId('vocabulary-level-4').click();
  await expect(words).toHaveCount(2);

  // 7. A word's detail: five dimensions, one live.
  await words.filter({ hasText: 'лук' }).click();
  await expect(page.getByTestId('vocabulary-sense-level')).toHaveCount(2);
  await expect(page.getByTestId('vocabulary-dimension-written_receptive').first()).toContainText('נחשפה');
  await expect(page.getByTestId('vocabulary-dimension-spelling').first()).toContainText('טרם תורגל');

  expect(diagnostics.pageErrors, report()).toEqual([]);
});
