import { expect, test } from '@playwright/test';

import { API_URL } from '../urls';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { lookUp, tapAndWaitForWrite, tapUntil } from './support/interactions';
import { LUK, PROCHITALA } from './support/lexemes';
import { answerChoice, generationStub, readCard, rightOption } from './support/cards';
import { clearGemini, expectGeminiPayload } from './support/mockServer';
import { createLearner, logIn } from './support/users';
import { withVoices } from './support/voices';

test.setTimeout(180_000);

// The saved form of each meaning, for reversed and typed cards (phase 23).
const FORM_OF: Record<string, string> = { קראה: 'прочитала', הקריאה: 'прочитала', בצל: 'лук', קשת: 'лук' };

test('past the seed, a session is built from the saved words', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  page.on('dialog', (dialog) => void dialog.accept());

  await withVoices(page, []);
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
  await expectGeminiPayload(request, generationStub());
  await page.getByTestId('create-button').click();
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('start-button')).toHaveText('התחל');

  // 5. Every card asks one of the saved words, whichever way round it asks.
  await tapUntil(page, 'start-button', 'progress-label');
  const words: string[] = [];
  for (let position = 1; position <= 4; position++) {
    const card = await readCard(page, position, 4);
    if (card.kind === 'choice') {
      words.push(card.prompt);
      await answerChoice(page, card, true);
    } else if (card.kind === 'reverse') {
      words.push(rightOption(card));
      await answerChoice(page, card, true);
    } else {
      words.push(FORM_OF[card.prompt]);
      await page.getByTestId('typed-show-answer').click();
    }
    await page.getByTestId('continue-button').click();
  }
  expect(words.every((word) => ['прочитала', 'лук'].includes(word)), words.join(', ')).toBe(true);

  // 6. Results lead to the next session, back on home.
  await expect(page.getByTestId('results-score')).toBeVisible();
  await page.getByTestId('results-next-session').click();
  await expect(page.getByTestId('preparing-label').or(page.getByTestId('start-button'))).toBeVisible();

  expect(diagnostics.pageErrors, report()).toEqual([]);
});

test('leaving mid-session offers resume', async ({ page, request }) => {
  await withVoices(page, []);
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
