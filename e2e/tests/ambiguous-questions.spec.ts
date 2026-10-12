import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { answerChoice, answerMeaning, answerTyped, expectGeneration, readCard, type Card } from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { lookUp, tapAndWaitForWrite, tapUntil } from './support/interactions';
import { PROCHITALA, SINGLE_WORDS, ZAMOK } from './support/lexemes';
import { knownSeeds, seedMemory, type MemorySeed } from './support/memory';
import { clearGemini, expectCheck, expectContext, expectJudge } from './support/mockServer';
import { stripIsolates } from './support/text';
import { openApp, signUpLearner } from './support/users';
import { withVoices } from './support/voices';

// Phase 34, the spec's e2e lines: a typed card shows the sentence that pins its
// sense (D6), and a right answer that is not the saved word gets a second try at
// it (D9). The sentence card's marked word (D8) is in sentence-cards.spec.ts.
// Phase 39: прочитала and замок are gloss families, so one meaning of each is
// known and the other is the one asked (spec D3, D5); one more word each takes
// the meaning card and the reversed card after the typed one.

test.setTimeout(180_000);

// The saved form of each meaning: what the typed card asks for.
const FORM_OF: Record<string, string> = {
  קראה: 'прочитала',
  הקריאה: 'прочитала',
  טירה: 'замок',
  מנעול: 'замок',
};

// Phase 39 (spec D5). Single-sense words for the meaning card and the reversed card.
const { blanket: REVERSE, mill: MEANING } = SINGLE_WORDS;

/** Another right word on every typed card: the batch's own alternative (spec
 *  D1), which no near miss of a saved form could be. */
const ALTERNATIVE = 'синоним';

/** The context call's Hebrew sentence for the typed card, which asks for טירה.
 *  It holds each of the four meanings once, whole, so the mark is the server's
 *  to find. */
const CONTEXT = 'אחרי הקריאה היא קראה על מנעול של טירה';
const CONTEXT_TRANSLATION = 'После чтения вслух она прочла о замке крепости';

/**
 * Phase 35 (spec D5, D6). The memory that gives four words four card types in
 * a fixed order, as question-types.spec.ts does, with טירה's R a little above
 * טחנה's so the typed card comes second. No voices and speaking off. Phase 39
 * (spec D2, D3): הקריאה and מנעול are known, so each family's other meaning is
 * its current one, and neither known meaning is asked beside it:
 * - קראה: no memory, beside a known meaning: a new meaning (spec D6), p 1, first.
 * - טירה: WP at R 0.855 (S 10, 18 days), level 3: recall, a typed translation
 *   (the table's first of three at the same p), p 0.855, second.
 * - טחנה: WR at R 0.85 (S 10, 19 days), level 3: a typed meaning, p 0.85, third.
 * - שמיכה: WP at R 0.50 (S 1, 90 days), level 1: a reversed card, p 0.78, last.
 */
const MEMORY: MemorySeed[] = [
  ...knownSeeds('הקריאה'),
  ...knownSeeds('מנעול'),
  { gloss: 'טירה', dimension: 'written_productive', stability: 10, daysAgo: 18, level: 3 },
  { gloss: MEANING.translation, dimension: 'written_receptive', stability: 10, daysAgo: 19, level: 3 },
  { gloss: REVERSE.translation, dimension: 'written_productive', stability: 1, daysAgo: 90, level: 1 },
];

/**
 * Past the seed, six saved senses of four words, their memory seeded, the stubs
 * for one session, and the session started at its typed card (2 of 4), past a
 * new meaning of прочитала. The checker reads the typed card's sentence as
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
  for (const word of [MEANING, REVERSE]) {
    await page.getByTestId('translate-new-word').click();
    await lookUp(page, request, word.form, word.payload);
    await tapAndWaitForWrite(page, page.getByTestId('translate-save'));
  }
  await page.getByTestId('translate-back').click();
  await seedMemory(username, MEMORY);

  await clearGemini(request);
  await expectGeneration(request, [ALTERNATIVE]);
  await expectContext(request, [{ key: 'q2', context: CONTEXT, context_translation: CONTEXT_TRANSLATION }]);
  await expectCheck(request, { q2c: { context_words: ['прочитала', 'замок'] } });
  await page.getByTestId('create-button').click();
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');

  // Phase 39 (spec D6): прочитала's other meaning, never asked, comes as a new
  // meaning of a word the learner knows, naming the known one.
  const first = await readCard(page, 1, 4, 'new-meaning');
  expect(first.prompt).toBe('прочитала');
  expect(stripIsolates(await page.getByTestId('known-meanings').textContent())).toBe('כבר למדתם: הקריאה');
  expect(first.options).toContain('קראה');
  await answerChoice(page, first, true);
  await page.getByTestId('continue-button').click();

  // Spec D6: the typed card shows a Hebrew sentence with its meaning marked.
  const card = await readCard(page, 2, 4, 'typed');
  expect(card.prompt).toBe('טירה');
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

/** Card 3, a meaning card, answered by a synonym the judge accepts, and card 4,
 *  the reversed card, answered right. */
async function finishTheSession(page: Page, request: APIRequestContext) {
  await readCard(page, 3, 4, 'meaning');
  await expectJudge(request, 'right');
  await answerMeaning(page, 'מילה');
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await page.getByTestId('continue-button').click();
  await answerChoice(page, await readCard(page, 4, 4, 'reverse'), true);
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await page.getByTestId('continue-button').click();
}

/** The results row of the gloss a card practised, by the meaning it showed. */
const practisedRow = (page: Page, meaning: string) =>
  page.getByTestId('practised-row').filter({ has: page.getByText(meaning, { exact: true }) });

/** Phase 39 (spec D5). The session asked one meaning of each family: the new
 *  meaning and the typed card's, never the known meaning beside either. */
async function expectOneMeaningPerFamily(page: Page) {
  await expect(practisedRow(page, 'קראה')).toHaveCount(1);
  await expect(practisedRow(page, 'טירה')).toHaveCount(1);
  await expect(practisedRow(page, 'הקריאה')).toHaveCount(0);
  await expect(practisedRow(page, 'מנעול')).toHaveCount(0);
}

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

  await finishTheSession(page, request);

  // The score counts the first answer, which was right; progress counts the
  // second, which was the saved word, so the typed card's word moved too.
  await expect(page.getByTestId('results-score')).toHaveText(/4\s*\/\s*4/);
  await expect(page.getByTestId('missed-row')).toHaveCount(0);
  await expect(page.getByTestId('practised-row')).toHaveCount(4);
  await expect(practisedRow(page, card.prompt).getByTestId(/^practised-(progressed|raised)$/)).toHaveCount(1);
  await expectOneMeaningPerFamily(page);

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

  await finishTheSession(page, request);

  // Still right in the score, and no progress for the typed card's word.
  await expect(page.getByTestId('results-score')).toHaveText(/4\s*\/\s*4/);
  await expect(page.getByTestId('missed-row')).toHaveCount(0);
  await expect(page.getByTestId('practised-row')).toHaveCount(4);
  // The other three moved: the new meaning and the reversed card progressed, the meaning card raised.
  await expect(page.getByTestId(/^practised-(progressed|raised)$/)).toHaveCount(3);
  await expect(practisedRow(page, card.prompt)).toHaveCount(1);
  await expect(practisedRow(page, card.prompt).getByTestId(/^practised-(progressed|raised)$/)).toHaveCount(0);
  await expectOneMeaningPerFamily(page);

  expect(diagnostics.pageErrors, report()).toEqual([]);
});
