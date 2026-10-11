import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { answerChoice, answerMeaning, answerTyped, generationStub, readCard, type Card } from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { lookUp, tapAndWaitForWrite, tapUntil } from './support/interactions';
import { PROCHITALA, ZAMOK } from './support/lexemes';
import { clearGemini, expectCheck, expectContext, expectGeminiPayload, expectJudge } from './support/mockServer';
import { stripIsolates } from './support/text';
import { openApp, signUpLearner } from './support/users';
import { withVoices } from './support/voices';

// Phase 34, the spec's e2e lines: a typed card shows the sentence that pins its
// sense (D6), and a right answer that is not the saved word gets a second try at
// it (D9). The sentence card's marked word (D8) is in sentence-cards.spec.ts.

test.setTimeout(180_000);

// The saved form of each meaning: what the typed card asks for.
const FORM_OF: Record<string, string> = {
  קראה: 'прочитала',
  הקריאה: 'прочитала',
  טירה: 'замок',
  מנעול: 'замок',
};

/** Another right word on every typed card: the batch's own alternative (spec
 *  D1), which no near miss of a saved form could be. */
const ALTERNATIVE = 'синоним';

/** The context call's Hebrew sentence for the typed card. Which of the four
 *  meanings the card shows is the plan's draw, so the sentence holds each of
 *  them once, whole, and the server marks whichever the card shows. */
const CONTEXT = 'אחרי הקריאה היא קראה על מנעול של טירה';
const CONTEXT_TRANSLATION = 'После чтения вслух она прочла о замке крепости';

/**
 * Past the seed, four saved senses of two words, the stubs for one session, and
 * the session started at its typed card (3 of 4). Ordinal 0, no voices,
 * speaking off: 1 choice, 2 reverse, 3 typed, 4 a meaning card
 * (question-types.spec.ts). The checker reads the typed card's sentence as
 * either saved word, so it keeps the sentence the context call wrote.
 */
async function reachTypedCard(page: Page, request: APIRequestContext, username: string, report: () => string): Promise<Card> {
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
  await lookUp(page, request, 'замок', ZAMOK);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save-all'));
  await page.getByTestId('translate-back').click();

  await clearGemini(request);
  await expectGeminiPayload(request, generationStub([ALTERNATIVE]));
  await expectContext(request, [{ key: 'q3', context: CONTEXT, context_translation: CONTEXT_TRANSLATION }]);
  await expectCheck(request, { q3c: { context_words: ['прочитала', 'замок'] } });
  await page.getByTestId('create-button').click();
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');

  for (const position of [1, 2]) {
    await answerChoice(page, await readCard(page, position, 4), true);
    await page.getByTestId('continue-button').click();
  }

  // Spec D6: the typed card shows a Hebrew sentence with its meaning marked.
  const card = await readCard(page, 3, 4);
  await expect(page.getByTestId('context-line')).toHaveText(CONTEXT);
  await expect(page.getByTestId('context-line-mark')).toHaveText(card.prompt);
  return card;
}

/** Spec D9: the alternative holds the card, with no banner, for a second try. */
async function answerWithTheAlternative(page: Page) {
  await answerTyped(page, ALTERNATIVE);
  await expect(page.getByTestId('retry-notice')).toBeVisible();
  // The answer is isolated inside the Hebrew line (strings.retryRight).
  await expect(page.getByTestId('retry-right')).toContainText(ALTERNATIVE);
  expect(stripIsolates(await page.getByTestId('retry-right').textContent())).toBe(`✓ נכון, ${ALTERNATIVE} מתאים כאן.`);
  await expect(page.getByTestId('retry-again')).toHaveText('יש מילה נוספת ששמרת — נסו שוב');
  await expect(page.getByTestId('continue-button')).toHaveCount(0);
  await expect(page.getByTestId('typed-input')).toHaveValue('');
  await expect(page.getByTestId('typed-input')).toBeEditable();
}

/** Card 4, a meaning card, answered by a synonym the judge accepts. */
async function finishWithTheMeaningCard(page: Page, request: APIRequestContext) {
  await readCard(page, 4, 4, 'meaning');
  await expectJudge(request, 'right');
  await answerMeaning(page, 'מילה');
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await page.getByTestId('continue-button').click();
}

/** The results row of the gloss a card practised, by the meaning it showed. */
const practisedRow = (page: Page, meaning: string) =>
  page.getByTestId('practised-row').filter({ has: page.getByText(meaning, { exact: true }) });

test('a typed card shows its sentence, and an alternative answer gets a second try that moves the word', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  const card = await reachTypedCard(page, request, 'e2e_second_try_ru', report);

  await answerWithTheAlternative(page);
  // The saved word on the second try: today's banner for an exact answer.
  await answerTyped(page, FORM_OF[card.prompt]);
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await expect(page.getByTestId('feedback-title')).toHaveText('נכון!');
  await expect(page.getByTestId('retry-notice')).toHaveCount(0);
  await page.getByTestId('continue-button').click();

  await finishWithTheMeaningCard(page, request);

  // The score counts the first answer, which was right; progress counts the
  // second, which was the saved word, so the typed card's word moved too.
  await expect(page.getByTestId('results-score')).toHaveText(/4\s*\/\s*4/);
  await expect(page.getByTestId('missed-row')).toHaveCount(0);
  await expect(page.getByTestId('practised-row')).toHaveCount(4);
  await expect(practisedRow(page, card.prompt).getByTestId(/^practised-(progressed|raised)$/)).toHaveCount(1);

  expect(diagnostics.pageErrors, report()).toEqual([]);
});

test('"show the answer" on a second try names the saved word in the green banner, and the word does not move', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  const card = await reachTypedCard(page, request, 'e2e_second_try_give_up_ru', report);

  await answerWithTheAlternative(page);
  // Ruling R16: the first answer was right, so giving up is not "wrong".
  await page.getByTestId('typed-show-answer').click();
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await expect(page.getByTestId('feedback-wrong')).toHaveCount(0);
  await expect(page.getByTestId('feedback-title')).toHaveText('נכון! המילה שתרגלנו:');
  expect(stripIsolates(await page.getByTestId('feedback-line').textContent())).toBe(FORM_OF[card.prompt]);
  await page.getByTestId('continue-button').click();

  await finishWithTheMeaningCard(page, request);

  // Still right in the score, and no progress for the typed card's word.
  await expect(page.getByTestId('results-score')).toHaveText(/4\s*\/\s*4/);
  await expect(page.getByTestId('missed-row')).toHaveCount(0);
  await expect(page.getByTestId('practised-row')).toHaveCount(4);
  await expect(page.getByTestId('practised-progressed')).toHaveCount(3);
  await expect(practisedRow(page, card.prompt)).toHaveCount(1);
  await expect(practisedRow(page, card.prompt).getByTestId(/^practised-(progressed|raised)$/)).toHaveCount(0);

  expect(diagnostics.pageErrors, report()).toEqual([]);
});
