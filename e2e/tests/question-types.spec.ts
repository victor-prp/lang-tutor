import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { answerChoice, answerTyped, generationStub, nearMiss, readCard, rightOption } from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { lookUp, tapAndWaitForWrite, tapUntil } from './support/interactions';
import { PROCHITALA, ZAMOK } from './support/lexemes';
import { clearGemini, expectGeminiPayload } from './support/mockServer';
import { stripIsolates } from './support/text';
import { createLearner, logIn } from './support/users';
import { withVoices } from './support/voices';

test.setTimeout(180_000);

// The saved form of each meaning: what a reversed card's right option and a
// typed card's answer are. Every form has five letters or more, so a typed card
// can always be answered with a near miss.
const FORM_OF: Record<string, string> = {
  קראה: 'прочитала',
  הקריאה: 'прочитала',
  טירה: 'замок',
  מנעול: 'замок',
};
const LEMMA_OF: Record<string, string> = { прочитала: 'прочитать', замок: 'замок' };

/** Past the seed, four saved senses of two words, and a list session started. */
async function startMixedSession(page: Page, request: APIRequestContext, username: string, report: () => string) {
  await withVoices(page, []);
  await createLearner(request, username, 'ru');
  await logIn(page, username);

  await tapUntil(page, 'start-button', 'progress-label');
  await page.getByTestId('session-skip').click();
  await expect(page.getByTestId('save-words-first'), report()).toBeVisible();

  await tapUntil(page, 'translate-entry', 'translate-input');
  await lookUp(page, request, 'прочитала', PROCHITALA);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save-all'));
  await page.getByTestId('translate-new-word').click();
  await lookUp(page, request, 'замок', ZAMOK);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save-all'));
  await page.getByTestId('translate-back').click();

  await clearGemini(request);
  await expectGeminiPayload(request, generationStub());
  await page.getByTestId('create-button').click();
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');
}

test('a list session mixes three card types, and a typed near miss counts', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  page.on('dialog', (dialog) => void dialog.accept());
  await startMixedSession(page, request, 'e2e_types_ru', report);

  // 1. Today's card: the word, its Hebrew meaning among four.
  let card = await readCard(page, 1, 4);
  expect(Object.values(FORM_OF)).toContain(card.prompt);
  await answerChoice(page, card, true);
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await page.getByTestId('continue-button').click();

  // 2. Turned round: the meaning and its part of speech, the word among four.
  card = await readCard(page, 2, 4);
  await expect(page.getByTestId('question-part-of-speech')).toBeVisible();
  expect(rightOption(card)).toBe(FORM_OF[card.prompt]);
  await answerChoice(page, card, true);
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await page.getByTestId('continue-button').click();

  // 3. Typed, with two letters swapped: a near miss, correct, spelling shown.
  card = await readCard(page, 3, 4);
  const typedMeaning = card.prompt;
  const typedForm = FORM_OF[typedMeaning];
  await answerTyped(page, nearMiss(typedForm));
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await expect(page.getByTestId('feedback-title')).toHaveText('כמעט! כך כותבים:');
  expect(stripIsolates(await page.getByTestId('feedback-line').textContent())).toBe(typedForm);
  await expect(page.getByTestId('typed-input')).not.toBeEditable();
  await page.getByTestId('continue-button').click();

  // 4. Today's card again: the cycle repeats.
  card = await readCard(page, 4, 4);
  await answerChoice(page, card, true);
  await page.getByTestId('continue-button').click();

  // Results: all four right. Over five dimensions no single card lifts a new
  // word's badge (a typed near miss leaves spelling new, so 2,2,1,1,1 is 1.4;
  // phase 25 recalibrated), so every word moves a level and says so.
  await expect(page.getByTestId('results-score')).toBeVisible();
  await expect(page.getByTestId('practised-row')).toHaveCount(4);
  await expect(page.getByTestId('practised-raised')).toHaveCount(0);
  await expect(page.getByTestId('practised-progressed')).toHaveCount(4);
  await expect(page.getByTestId('practised-progressed').first()).toHaveText('התקדמות: זיהוי בכתב');

  // The typed sense: writing has a level, and the near miss left spelling new.
  await page.getByTestId('results-done').click();
  await tapUntil(page, 'vocabulary-entry', 'vocabulary-word');
  await page.getByTestId('vocabulary-word').filter({ hasText: LEMMA_OF[typedForm] }).click();
  const sense = page.getByTestId('vocabulary-sense').filter({ hasText: typedMeaning });
  await expect(sense.getByTestId('vocabulary-dimension-written_productive')).toContainText('נחשפה');
  await expect(sense.getByTestId('vocabulary-dimension-spelling')).toContainText('חדשה');

  expect(diagnostics.pageErrors, report()).toEqual([]);
});

test('"show the answer" on a typed card is wrong, and the word is missed', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  page.on('dialog', (dialog) => void dialog.accept());
  await startMixedSession(page, request, 'e2e_types_show_ru', report);

  for (const position of [1, 2]) {
    await answerChoice(page, await readCard(page, position, 4), true);
    await page.getByTestId('continue-button').click();
  }

  const card = await readCard(page, 3, 4);
  await page.getByTestId('typed-show-answer').click();
  await expect(page.getByTestId('feedback-wrong')).toBeVisible();
  expect(stripIsolates(await page.getByTestId('feedback-line').textContent())).toBe(FORM_OF[card.prompt]);
  await page.getByTestId('continue-button').click();

  await answerChoice(page, await readCard(page, 4, 4), true);
  await page.getByTestId('continue-button').click();

  await expect(page.getByTestId('results-score')).toHaveText(/3\s*\/\s*4/);
  const missed = page.getByTestId('missed-row');
  await expect(missed).toHaveCount(1);
  await expect(missed).toContainText(FORM_OF[card.prompt]);
  await expect(missed).toContainText(card.prompt);

  expect(diagnostics.pageErrors, report()).toEqual([]);
});
