import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { answerChoice, answerMeaning, answerTyped, expectGeneration, nearMiss, readCard, rightOption, type CardKind } from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { lookUp, tapAndWaitForWrite, tapUntil } from './support/interactions';
import { SINGLE_WORDS } from './support/lexemes';
import { seedMemory, type MemorySeed } from './support/memory';
import { clearGemini, expectJudge } from './support/mockServer';
import { stripIsolates } from './support/text';
import { openApp, signUpLearner } from './support/users';
import { withVoices } from './support/voices';

test.setTimeout(180_000);

// Phase 39 (spec D5). Four single-sense words, one per card type: two senses of
// one form are a gloss family, and a session asks only one of them.
const { jug: CHOICE, blanket: REVERSE, camel: TYPED, mill: MEANING } = SINGLE_WORDS;
const WORDS = [CHOICE, REVERSE, TYPED, MEANING];

// The saved form of each meaning: what a reversed card's right option and a
// typed card's answer are. Every form has five letters or more, so a typed card
// can always be answered with a near miss. Each form is its own lemma.
const FORM_OF: Record<string, string> = Object.fromEntries(WORDS.map((w) => [w.translation, w.form]));

/**
 * Phase 35 (spec D5, D6). The memory that gives the four words four card
 * types; no voices and speaking off, so the live dimensions are WR, WP and SP.
 * Each seeded word is due on the one dimension it has a row for:
 * - כד: no memory, a new word: a choice of meanings.
 * - שמיכה: WP at R 0.50 (S 1, 90 days), level 1: recognition. The reversed
 *   card's p is 0.25 + 0.75·√0.50 = 0.78, nearer 0.85 than tiles' √0.50 = 0.71,
 *   and with no saved example there is no gap to choose.
 * - גמל: WP at R 0.85 (S 10, 19 days), level 3: recall. A typed translation,
 *   a typed gap and a sentence all have p = 0.85; the tie goes to the table's
 *   first, the typed translation.
 * - טחנה: WR at R 0.85 (S 10, 19 days), level 3: recall, a typed meaning.
 */
const MEMORY: MemorySeed[] = [
  { gloss: REVERSE.translation, dimension: 'written_productive', stability: 1, daysAgo: 90, level: 1 },
  { gloss: TYPED.translation, dimension: 'written_productive', stability: 10, daysAgo: 19, level: 3 },
  { gloss: MEANING.translation, dimension: 'written_receptive', stability: 10, daysAgo: 19, level: 3 },
];

/** Past the seed, four saved words, their memory seeded, and a list session
 *  started. */
async function startMixedSession(page: Page, request: APIRequestContext, username: string, report: () => string) {
  await withVoices(page, []);
  await signUpLearner(page, username, 'ru');
  await openApp(page);

  await tapUntil(page, 'start-button', 'progress-label');
  await page.getByTestId('session-skip').click();
  await expect(page.getByTestId('save-words-first'), report()).toBeVisible();

  await tapUntil(page, 'translate-entry', 'translate-input');
  for (const [index, word] of WORDS.entries()) {
    if (index > 0) await page.getByTestId('translate-new-word').click();
    await lookUp(page, request, word.form, word.payload);
    // One sense, so its own save button: "save all" is for two or more.
    await tapAndWaitForWrite(page, page.getByTestId('translate-save'));
  }
  await seedMemory(username, MEMORY);

  await clearGemini(request);
  await expectGeneration(request);
  // Phase 43 (spec D7). Home makes the session itself, so the memory and the
  // stubs are in place before going back.
  await page.getByTestId('translate-back').click();
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');
}

test('a list session mixes card types, and a typed near miss counts', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  page.on('dialog', (dialog) => void dialog.accept());
  await startMixedSession(page, request, 'e2e_types_ru', report);

  // The four cards come in the order of their chance of success (spec D6), so
  // each is answered by the type on screen.
  const kinds: CardKind[] = [];
  let typedMeaning = '';
  for (let position = 1; position <= 4; position++) {
    const card = await readCard(page, position, 4);
    kinds.push(card.kind);
    if (card.kind === 'choice') {
      // Today's card: the word, its Hebrew meaning among four.
      expect(Object.values(FORM_OF)).toContain(card.prompt);
      await answerChoice(page, card, true);
      await expect(page.getByTestId('feedback-correct')).toBeVisible();
    } else if (card.kind === 'reverse') {
      // Turned round: the meaning and its part of speech, the word among four.
      await expect(page.getByTestId('question-part-of-speech')).toBeVisible();
      expect(rightOption(card)).toBe(FORM_OF[card.prompt]);
      await answerChoice(page, card, true);
      await expect(page.getByTestId('feedback-correct')).toBeVisible();
    } else if (card.kind === 'typed') {
      // Typed, with two letters swapped: a near miss, correct, spelling shown.
      typedMeaning = card.prompt;
      await answerTyped(page, nearMiss(FORM_OF[typedMeaning]));
      await expect(page.getByTestId('feedback-correct')).toBeVisible();
      await expect(page.getByTestId('feedback-title')).toHaveText('כמעט! כך כותבים:');
      expect(stripIsolates(await page.getByTestId('feedback-line').textContent())).toBe(FORM_OF[typedMeaning]);
      await expect(page.getByTestId('typed-input')).not.toBeEditable();
    } else {
      // A meaning card: a synonym is the judge's.
      expect(card.kind).toBe('meaning');
      await expectJudge(request, 'right');
      await answerMeaning(page, 'מילה');
      await expect(page.getByTestId('feedback-correct')).toBeVisible();
    }
    await page.getByTestId('continue-button').click();
  }
  expect([...kinds].sort()).toEqual(['choice', 'meaning', 'reverse', 'typed']);
  const typedForm = FORM_OF[typedMeaning];

  // Results: all four right, and every word moves a level and says so. The
  // badge is the mean over five dimensions, rounded: the choice and the
  // reversed card leave it at 1 (2,1,1,1,1 and 2,2,1,1,1) and say what rose;
  // the two recall cards start from a seeded level 3 and lift it to 2 (the
  // near miss: 2,4,1,1,1; the meaning: 4,1,1,1,1).
  await expect(page.getByTestId('results-score')).toBeVisible();
  await expect(page.getByTestId('practised-row')).toHaveCount(4);
  await expect(page.getByTestId('practised-raised')).toHaveCount(2);
  await expect(page.getByTestId('practised-progressed')).toHaveCount(2);
  await expect(page.getByTestId('practised-row').filter({ hasText: typedMeaning }).getByTestId('practised-raised')).toHaveCount(1);
  await expect(page.getByTestId('practised-row').filter({ hasText: CHOICE.translation }).getByTestId('practised-progressed')).toHaveText(
    'התקדמות: זיהוי בכתב',
  );

  // The typed sense: writing went up a level from its seeded 3, and the near
  // miss left spelling new.
  await page.getByTestId('results-done').click();
  await tapUntil(page, 'vocabulary-entry', 'vocabulary-word');
  await page.getByTestId('vocabulary-word').filter({ hasText: typedForm }).click();
  const sense = page.getByTestId('vocabulary-sense').filter({ hasText: typedMeaning });
  await expect(sense.getByTestId('vocabulary-dimension-written_productive')).toContainText('ידועה');
  await expect(sense.getByTestId('vocabulary-dimension-spelling')).toContainText('חדשה');

  expect(diagnostics.pageErrors, report()).toEqual([]);
});

test('"show the answer" on a typed card is wrong, and the word is missed', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  page.on('dialog', (dialog) => void dialog.accept());
  await startMixedSession(page, request, 'e2e_types_show_ru', report);

  // Every card right but the typed one, whose answer is shown instead.
  let shown = '';
  for (let position = 1; position <= 4; position++) {
    const card = await readCard(page, position, 4);
    if (card.kind === 'typed') {
      shown = card.prompt;
      await page.getByTestId('typed-show-answer').click();
      await expect(page.getByTestId('feedback-wrong')).toBeVisible();
      expect(stripIsolates(await page.getByTestId('feedback-line').textContent())).toBe(FORM_OF[shown]);
    } else if (card.kind === 'meaning') {
      // Answered by a synonym the judge accepts.
      await expectJudge(request, 'right');
      await answerMeaning(page, 'מילה');
    } else {
      await answerChoice(page, card, true);
    }
    await page.getByTestId('continue-button').click();
  }
  expect(shown, 'no typed card').not.toBe('');

  await expect(page.getByTestId('results-score')).toHaveText(/3\s*\/\s*4/);
  const missed = page.getByTestId('missed-row');
  await expect(missed).toHaveCount(1);
  await expect(missed).toContainText(FORM_OF[shown]);
  await expect(missed).toContainText(shown);

  expect(diagnostics.pageErrors, report()).toEqual([]);
});
