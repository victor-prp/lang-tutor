import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { answerChoice, answerMeaning, expectGeneration, readCard } from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { lookUp, tapAndWaitForWrite, tapUntil } from './support/interactions';
import { LUK, PROCHITALA } from './support/lexemes';
import { seedMemory } from './support/memory';
import { clearGemini, expectJudge } from './support/mockServer';
import { stripIsolates } from './support/text';
import { openApp, signUpLearner } from './support/users';
import { withVoices } from './support/voices';

test.setTimeout(180_000);

// The saved meanings of each form: a meaning card shows the form and asks for one of them.
const MEANINGS_OF: Record<string, string[]> = { прочитала: ['קראה', 'הקריאה'], лук: ['בצל', 'קשת'] };
// Hebrew that is no saved meaning of either word, so only the judge can accept it.
const SYNONYM = 'מילה';

/** Phase 39 (spec D5). Each word's two senses are a gloss family, and a session
 *  asks one gloss of a family: two cards. */
const CARDS = 2;

/** Past the seed, four saved senses of two words, and the session on its
 *  meaning card, every card before it answered right. Phase 35 (spec D5, D6):
 *  בצל is due on written recognition, WR at R 0.85 (S 10, 19 days) and level 3,
 *  so it is asked by recall, a typed meaning. Phase 39 (spec D3): practised,
 *  it is лук's current meaning, and קשת waits; one of прочитала's two new
 *  meanings is asked, a choice of meanings, and the other waits. The order
 *  follows each card's chance of success, so the meaning card is found by its
 *  type. */
async function reachMeaningCard(page: Page, request: APIRequestContext, username: string, report: () => string) {
  page.on('dialog', (dialog) => void dialog.accept());
  await withVoices(page, []);
  await signUpLearner(page, username, 'ru');
  await openApp(page);

  await tapUntil(page, 'start-button', 'progress-label');
  await page.getByTestId('session-skip').click();
  await expect(page.getByTestId('save-words-first'), report()).toBeVisible();

  await tapUntil(page, 'translate-entry', 'translate-input');
  await lookUp(page, request, 'прочитала', PROCHITALA);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save-all'));
  await page.getByTestId('translate-new-word').click();
  await lookUp(page, request, 'лук', LUK);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save-all'));
  await seedMemory(username, [{ gloss: 'בצל', dimension: 'written_receptive', stability: 10, daysAgo: 19, level: 3 }]);

  await clearGemini(request);
  await expectGeneration(request);
  // Phase 43 (spec D7). Home makes the session itself, so the memory and the
  // stubs are in place before going back.
  await page.getByTestId('translate-back').click();
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');

  for (let position = 1; position <= CARDS; position++) {
    const card = await readCard(page, position, CARDS);
    if (card.kind === 'meaning') return { card, position };
    expect(card.kind, `position ${position}`).toBe('choice');
    await answerChoice(page, card, true);
    await page.getByTestId('continue-button').click();
  }
  throw new Error('the session asked no meaning card');
}

/** The rest of the session after the meaning card: choices, answered right. */
async function finishSession(page: Page, after: number) {
  for (let position = after + 1; position <= CARDS; position++) {
    await answerChoice(page, await readCard(page, position, CARDS, 'choice'), true);
    await page.getByTestId('continue-button').click();
  }
}

test('a meaning card: a synonym is judged right, and the saved meaning is shown', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  const { card, position } = await reachMeaningCard(page, request, 'e2e_meaning_ru', report);

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
  await finishSession(page, position);

  // Results: the word is listed with its saved meaning.
  await expect(page.getByTestId('results-score')).toBeVisible();
  const row = page.getByTestId('practised-row').filter({ hasText: card.prompt }).filter({ hasText: saved });
  await expect(row).toHaveCount(1);

  expect(diagnostics.pageErrors, report()).toEqual([]);
});

test('a meaning card: a failed check keeps the text, and trying again can still succeed', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  const { card } = await reachMeaningCard(page, request, 'e2e_meaning_fail_ru', report);

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
