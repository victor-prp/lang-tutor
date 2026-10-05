import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { clearGemini, expectGemini, expectGeminiPayload } from './support/mockServer';
import { stripIsolates } from './support/text';
import { createLearner, logIn } from './support/users';

test.setTimeout(180_000);

// The same new lexemes vocabulary.spec.ts uses: four senses, two forms.
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
// Three wrong options for any key up to ten, none equal to a right answer above.
const DISTRACTORS = {
  items: Array.from({ length: 10 }, (_, i) => ({ key: `q${i + 1}`, distractors: ['דלת', 'קיר', 'תקרה'] })),
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

test('past the seed, a session is built from the saved words', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  page.on('dialog', (dialog) => void dialog.accept());

  await createLearner(request, 'e2e_next_ru', 'ru');
  await logIn(page, 'e2e_next_ru');

  // 1. The seed comes first. Enter it, then skip it.
  await tapUntil(page, 'start-button', 'progress-label');
  await page.getByTestId('session-skip').click();

  // 2. Past the seed with nothing saved: the empty-list state, not a quiz.
  await expect(page.getByTestId('save-words-first'), report()).toBeVisible();

  // 3. Save four senses of two words.
  await tapUntil(page, 'translate-entry', 'translate-input');
  await lookUp(page, request, 'прочитала', PROCHITALA);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save-all'));
  await page.getByTestId('translate-new-word').click();
  await lookUp(page, request, 'лук', LUK);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save-all'));
  await page.getByTestId('translate-back').click();

  // 4. Create questions. The job turns the session ready, and home's poll sees it.
  await clearGemini(request);
  await expectGeminiPayload(request, DISTRACTORS);
  await page.getByTestId('create-button').click();
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('start-button')).toHaveText('התחל');

  // 5. Every question is one of the saved forms.
  await tapUntil(page, 'start-button', 'progress-label');
  const prompts: string[] = [];
  for (let position = 1; position <= 4; position++) {
    await expect(page.getByTestId('progress-label')).toHaveText(new RegExp(`${position}\\s*/\\s*4`));
    prompts.push(stripIsolates(await page.getByTestId('question-prompt').textContent()));
    await page.getByTestId('option-0').click();
    await page.getByTestId('continue-button').click();
  }
  expect(prompts.every((prompt) => ['прочитала', 'лук'].includes(prompt)), prompts.join(', ')).toBe(true);

  // 6. Results lead to the next session, back on home.
  await expect(page.getByTestId('results-score')).toBeVisible();
  await page.getByTestId('results-next-session').click();
  await expect(page.getByTestId('preparing-label').or(page.getByTestId('start-button'))).toBeVisible();

  expect(diagnostics.pageErrors, report()).toEqual([]);
});

test('leaving mid-session offers resume', async ({ page, request }) => {
  await createLearner(request, 'e2e_resume_ru', 'ru');
  await logIn(page, 'e2e_resume_ru');

  await tapUntil(page, 'start-button', 'progress-label');
  await page.getByTestId('option-0').click();
  await page.getByTestId('continue-button').click();
  await expect(page.getByTestId('progress-label')).toHaveText(/2\s*\/\s*10/);
  await page.getByTestId('session-back').click();

  await expect(page.getByTestId('start-button')).toHaveText('המשך');
  await tapUntil(page, 'start-button', 'progress-label');
  await expect(page.getByTestId('progress-label')).toHaveText(/2\s*\/\s*10/);
});
