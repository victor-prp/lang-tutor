import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { answerChoice, answerTyped, buildTiles, expectGeneration, readCard, rightOption } from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { lookUp, tapAndWaitForWrite, tapUntil } from './support/interactions';
import { SINGLE_WORDS } from './support/lexemes';
import { clearGemini } from './support/mockServer';
import { continueMeet, retireStock } from './support/sessions';
import { stripIsolates } from './support/text';
import { openApp, signUpLearner } from './support/users';
import { spoken, withVoices } from './support/voices';

test.setTimeout(180_000);

// Phase 54 (spec D1, D3, D5). A word with no memory is met before it is asked:
// an ungraded meet card, then a choice of meanings, a choice of words and a
// typed translation. Phase 55 (spec D1, D2): the meet card no longer asks for
// the word aloud, and the intro stage goes on to build it from tiles at once.
// This browser has no microphone, so the session cannot speak and the intro
// stage has no read aloud (speaking.spec.ts plays one). Two single-sense words,
// so each is a ladder of its own.
const { jug: FIRST, camel: SECOND } = SINGLE_WORDS;
const FORM_OF: Record<string, string> = { [FIRST.translation]: FIRST.form, [SECOND.translation]: SECOND.form };
const MEANING_OF: Record<string, string> = { [FIRST.form]: FIRST.translation, [SECOND.form]: SECOND.translation };

/** Past the seed, `words` saved, their session stubbed, ready, and started. The
 *  browser speaks Russian, so a card's voice is heard. */
async function startSession(page: Page, request: APIRequestContext, username: string, words: (typeof FIRST)[], report: () => string) {
  page.on('dialog', (dialog) => void dialog.accept());
  await withVoices(page, ['ru-RU']);
  await signUpLearner(page, username, 'ru');
  await openApp(page);

  await tapUntil(page, 'start-button', 'progress-label');
  await page.getByTestId('session-skip').click();
  await expect(page.getByTestId('save-words-first'), report()).toBeVisible();

  await tapUntil(page, 'translate-entry', 'translate-input');
  for (const [index, word] of words.entries()) {
    if (index > 0) await page.getByTestId('translate-new-word').click();
    await lookUp(page, request, word.form, word.payload);
    await tapAndWaitForWrite(page, page.getByTestId('translate-save'));
  }

  // Phase 43 (spec D7). Home makes the session itself, so the stubs are in
  // place before going back. A stock that landed between two saves holds only
  // the first word: retire it, so the session Home makes holds them all.
  await clearGemini(request);
  await expectGeneration(request);
  await retireStock(page.request);
  await page.getByTestId('translate-back').click();
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
}

const bannerCount = (page: Page) => page.getByTestId(/^(continue-button|feedback-(correct|wrong|other))$/).count();

test('a new word is met first: its form and meaning, said aloud; המשך moves on with no banner, and the meet card is no part of the score', async ({
  page,
  request,
}) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  await startSession(page, request, 'e2e_meet_ru', [FIRST], report);

  const before = (await spoken(page)).length;
  await tapUntil(page, 'start-button', 'progress-label');

  // 1. The meet card: a new word, its form large, said on arrival, and its meaning.
  // One ladder is its five cards, the meet card counted. Phase 55 (spec D1): it
  // no longer asks for the word aloud, which nothing would hear.
  const total = 5;
  const meet = await readCard(page, 1, total, 'meet');
  expect(meet.prompt).toBe(FIRST.form);
  await expect(page.getByTestId('meet-title')).toHaveText('מילה חדשה');
  await expect(page.getByTestId('meet-say')).toHaveCount(0);
  expect(stripIsolates(await page.getByTestId('meet-meaning').textContent())).toBe(FIRST.translation);
  await expect(page.getByTestId('speak-form')).toBeVisible();
  await expect(page.getByTestId('meet-continue')).toHaveText('המשך');
  // Nothing to answer: no options, no input, no microphone, no banner.
  await expect(page.locator('[data-testid^="option-"]')).toHaveCount(0);
  await expect(page.getByTestId('typed-input')).toHaveCount(0);
  await expect(page.getByTestId('speak-record')).toHaveCount(0);
  expect(await bannerCount(page)).toBe(0);
  await expect.poll(async () => (await spoken(page)).slice(before)).toEqual([{ text: FIRST.form, lang: 'ru-RU' }]);

  // 2. The play button says it again.
  await page.getByTestId('speak-form').click();
  await expect.poll(async () => (await spoken(page)).slice(before)).toEqual([
    { text: FIRST.form, lang: 'ru-RU' },
    { text: FIRST.form, lang: 'ru-RU' },
  ]);

  // 3. המשך sends `seen` and moves on at once, with no banner to continue from.
  const sent = page.waitForRequest((req) => req.method() === 'POST' && /\/next-step$/.test(req.url()));
  await continueMeet(page);
  const body = (await sent).postDataJSON() as Record<string, unknown>;
  expect(body).toEqual({ question_id: expect.any(String), seen: true });
  expect(await bannerCount(page)).toBe(0);

  // 4. Phase 55 (spec D2, D3): straight after it, the word is built from its tiles, graded.
  const tiles = await readCard(page, 2, total, 'tiles');
  expect(tiles.prompt).toBe(FIRST.translation);
  await buildTiles(page, FIRST.form);
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await page.getByTestId('continue-button').click();

  // 5. Then the word is asked three ways, each graded.
  const choice = await readCard(page, 3, total, 'choice');
  expect(choice.prompt).toBe(FIRST.form);
  await answerChoice(page, choice, true);
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await page.getByTestId('continue-button').click();

  const reverse = await readCard(page, 4, total, 'reverse');
  expect(reverse.prompt).toBe(FIRST.translation);
  expect(rightOption(reverse)).toBe(FIRST.form);
  await answerChoice(page, reverse, true);
  await page.getByTestId('continue-button').click();

  const typed = await readCard(page, 5, total, 'typed');
  expect(typed.prompt).toBe(FIRST.translation);
  await answerTyped(page, FIRST.form);
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await page.getByTestId('continue-button').click();

  // 6. The meet card asked nothing: four graded answers, the tiles' among them, all right, and no miss.
  await expect(page.getByTestId('results-score')).toBeVisible();
  expect(stripIsolates(await page.getByTestId('results-score').textContent())).toBe('4 / 4');
  await expect(page.getByTestId('missed-row')).toHaveCount(0);
  await expect(page.getByTestId('practised-row')).toHaveCount(1);

  expect(diagnostics.pageErrors, report()).toEqual([]);
});

test('two new words: each is met and built from tiles first, then asked three ways, the two words taking turns', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  await startSession(page, request, 'e2e_meet_two_ru', [FIRST, SECOND], report);
  await tapUntil(page, 'start-button', 'progress-label');

  // Phase 55 (spec D3): each word's intro stage is one unit, its meet card and
  // then its tiles, back to back; then every first practice card, every second,
  // every third, each stage in the same word order. Two practice cards of a word
  // are a stage apart, with the other word's card between them.
  const total = 10;
  const order: string[] = [];
  for (const position of [1, 3]) {
    const meet = await readCard(page, position, total, 'meet');
    order.push(meet.prompt);
    await continueMeet(page);
    const tiles = await readCard(page, position + 1, total, 'tiles');
    expect(tiles.prompt).toBe(MEANING_OF[meet.prompt]);
    await buildTiles(page, meet.prompt);
    await expect(page.getByTestId('feedback-correct')).toBeVisible();
    await page.getByTestId('continue-button').click();
  }
  expect([...order].sort()).toEqual([FIRST.form, SECOND.form].sort());

  for (const [index, form] of order.entries()) {
    const card = await readCard(page, 5 + index, total, 'choice');
    expect(card.prompt).toBe(form);
    await answerChoice(page, card, true);
    await page.getByTestId('continue-button').click();
  }
  for (const [index, form] of order.entries()) {
    const card = await readCard(page, 7 + index, total, 'reverse');
    expect(card.prompt).toBe(MEANING_OF[form]);
    await answerChoice(page, card, true);
    await page.getByTestId('continue-button').click();
  }
  for (const [index, form] of order.entries()) {
    const card = await readCard(page, 9 + index, total, 'typed');
    expect(FORM_OF[card.prompt]).toBe(form);
    await answerTyped(page, form);
    await page.getByTestId('continue-button').click();
  }

  // Two meet cards in ten: the score is eight answers, all right.
  await expect(page.getByTestId('results-score')).toBeVisible();
  expect(stripIsolates(await page.getByTestId('results-score').textContent())).toBe('8 / 8');
  await expect(page.getByTestId('practised-row')).toHaveCount(2);

  expect(diagnostics.pageErrors, report()).toEqual([]);
});
