import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { answerChoice, answerMeaning, answerTyped, generationStubFor, readCard } from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { lookUp, tapAndWaitForWrite, tapUntil } from './support/interactions';
import { LUK, PROCHITALA } from './support/lexemes';
import { clearGemini, expectGeminiPayload, expectJudge } from './support/mockServer';
import { stripIsolates } from './support/text';
import { createLearner, logIn } from './support/users';
import { withVoices } from './support/voices';

test.setTimeout(180_000);

// The saved form of each meaning, for reversed and typed cards.
const FORM_OF: Record<string, string> = { קראה: 'прочитала', הקריאה: 'прочитала', בצל: 'лук', קשת: 'лук' };
// The saved meanings of each form: a meaning card shows the form and asks for one of them.
const MEANINGS_OF: Record<string, string[]> = { прочитала: ['קראה', 'הקריאה'], лук: ['בצל', 'קשת'] };
// Hebrew that is no saved meaning of either word, so only the judge can accept it.
const SYNONYM = 'מילה';

/** Past the seed, four saved senses of two words, positions 1-3 answered right,
 *  and the session on its fourth card: with no voices and speaking off, ordinal 0
 *  and run 1 prefer listen_choice, which falls through to typed_meaning (D9). */
async function reachMeaningCard(page: Page, request: APIRequestContext, username: string, report: () => string) {
  page.on('dialog', (dialog) => void dialog.accept());
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
  await lookUp(page, request, 'лук', LUK);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save-all'));
  await page.getByTestId('translate-back').click();

  await clearGemini(request);
  await expectGeminiPayload(request, generationStubFor({ 1: 'meaning', 2: 'word', 3: 'typed' }));
  await page.getByTestId('create-button').click();
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');

  await answerChoice(page, await readCard(page, 1, 4, 'choice'), true);
  await page.getByTestId('continue-button').click();
  await answerChoice(page, await readCard(page, 2, 4, 'reverse'), true);
  await page.getByTestId('continue-button').click();
  const typed = await readCard(page, 3, 4, 'typed');
  await answerTyped(page, FORM_OF[typed.prompt]);
  await page.getByTestId('continue-button').click();

  return readCard(page, 4, 4, 'meaning');
}

test('a meaning card: a synonym is judged right, and the saved meaning is shown', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  const card = await reachMeaningCard(page, request, 'e2e_meaning_ru', report);

  await expect(page.getByText('כתבו את הפירוש בעברית')).toBeVisible();
  expect(Object.keys(MEANINGS_OF)).toContain(card.prompt);
  await expect(page.getByTestId('typed-input')).toHaveCSS('direction', 'rtl');

  // A synonym is the judge's to decide; held back so "checking" can be seen.
  await expectJudge(request, 'right', { delayMs: 1_500 });
  await answerMeaning(page, SYNONYM);
  await expect(page.getByTestId('typed-submit')).toHaveText('בודקים…');
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await expect(page.getByTestId('feedback-title')).toHaveText('נכון! הפירוש השמור:');
  const saved = stripIsolates(await page.getByTestId('feedback-line').textContent());
  expect(MEANINGS_OF[card.prompt]).toContain(saved);
  await page.getByTestId('continue-button').click();

  // Results: the word is listed with its saved meaning.
  await expect(page.getByTestId('results-score')).toBeVisible();
  const row = page.getByTestId('practised-row').filter({ hasText: card.prompt }).filter({ hasText: saved });
  await expect(row).toHaveCount(1);

  expect(diagnostics.pageErrors, report()).toEqual([]);
});

test('a meaning card: a failed check keeps the text, and trying again can still succeed', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  const card = await reachMeaningCard(page, request, 'e2e_meaning_fail_ru', report);

  await expectJudge(request, 'right', { status: 500 });
  await answerMeaning(page, SYNONYM);
  await expect(page.getByTestId('judge-failed')).toHaveText('לא הצלחנו לבדוק');
  await expect(page.getByTestId('judge-try-again')).toHaveText('נסו שוב');
  await expect(page.getByTestId('typed-input')).toHaveValue(SYNONYM);
  await expect(page.getByTestId('feedback-correct')).not.toBeVisible();
  await expect(page.getByTestId('feedback-wrong')).not.toBeVisible();

  // The box is editable again: trying again judges what is in it, not the text that failed.
  const EDITED = 'לשריין מקום';
  await page.getByTestId('typed-input').fill(EDITED);
  await expectJudge(request, 'wrong');
  await page.getByTestId('judge-try-again').click();
  await expect(page.getByTestId('typed-input')).toHaveValue(EDITED);
  await expect(page.getByTestId('feedback-wrong')).toBeVisible();
  await expect(page.getByTestId('feedback-title')).toHaveText('התשובה הנכונה:');
  expect(MEANINGS_OF[card.prompt]).toContain(stripIsolates(await page.getByTestId('feedback-line').textContent()));

  expect(diagnostics.pageErrors, report()).toEqual([]);
});
