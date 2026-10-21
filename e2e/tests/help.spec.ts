import { tileLetters } from '@lang-tutor/core/domain';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { answerChoice, answerTyped, buildTiles, expectGeneration, readCard, tilesOnScreen } from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { lookUp, tapAndWaitForWrite, tapUntil } from './support/interactions';
import { SINGLE_WORDS } from './support/lexemes';
import { clearGemini } from './support/mockServer';
import { continueMeet, retireStock } from './support/sessions';
import { stripIsolates } from './support/text';
import { openApp, signUpLearner } from './support/users';
import { spoken, withVoices } from './support/voices';

test.setTimeout(180_000);

// Phase 55 (spec D6, D7). Help on a new word's tiles and typed cards: a wrong
// tile is not placed and says so, help places the next letter or reveals the
// next one, and a wrong typed answer is typed again before its banner. A helped
// answer is wrong in the score, however its text came out. One single-sense
// word, so the session is one ladder; no microphone, so no read aloud.
const WORD = SINGLE_WORDS.camel;
/** Far from the word, so wrong and not a near miss; Cyrillic, so the script gate lets it through. */
const WRONG = 'неверно';

/** Past the seed, the word saved, its session stubbed, ready, and started. */
async function startSession(page: Page, request: APIRequestContext, username: string, report: () => string) {
  page.on('dialog', (dialog) => void dialog.accept());
  await withVoices(page, ['ru-RU']);
  await signUpLearner(page, username, 'ru');
  await openApp(page);

  await tapUntil(page, 'start-button', 'progress-label');
  await page.getByTestId('session-skip').click();
  await expect(page.getByTestId('save-words-first'), report()).toBeVisible();

  await tapUntil(page, 'translate-entry', 'translate-input');
  await lookUp(page, request, WORD.form, WORD.payload);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save'));

  // Phase 43 (spec D7). Home makes the session itself, so the stubs are in place before going back.
  await clearGemini(request);
  await expectGeneration(request);
  await retireStock(page.request);
  await page.getByTestId('translate-back').click();
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');
}

test('a wrong tile, the tiles help, the typed help and the retype: both helped cards count wrong', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  // Every answer the app sends, in order: a retype is never one of them.
  const sent: unknown[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/next-step$/.test(req.url())) sent.push(req.postDataJSON());
  });
  await startSession(page, request, 'e2e_help_ru', report);

  // The ladder: met, written from tiles, then asked three ways.
  const total = 5;
  await readCard(page, 1, total, 'meet');
  await continueMeet(page);

  // 1. The tiles card answers itself: there is no check button.
  const tiles = await readCard(page, 2, total, 'tiles');
  expect(tiles.prompt).toBe(WORD.translation);
  await expect(page.getByTestId('tiles-submit')).toHaveCount(0);
  const letters = tileLetters(WORD.form)!;
  const slots = page.getByTestId(/^tile-slot-\d+$/);

  // A wrong tile is not placed, and the card says so.
  const wrong = (await tilesOnScreen(page)).findIndex((letter) => letter !== letters[0]);
  await page.getByTestId(`tile-${wrong}`).click();
  await expect(page.getByTestId('tiles-wrong')).toHaveText('לא האות הזאת');
  await expect(slots).toHaveCount(0);

  // עזרה places the first letter, which ends the wrong line; a placed tile stays put.
  // Phase 63 (spec D1, D5): the bulb and עזרה, at the end of the built word's box.
  await expect(page.getByTestId('tiles-help')).toContainText('עזרה');
  await page.getByTestId('tiles-help').click();
  await expect(slots).toHaveCount(1);
  await expect(page.getByTestId('tile-slot-0')).toHaveText(letters[0]);
  await expect(page.getByTestId('tiles-wrong')).toHaveCount(0);
  await page.getByTestId('tile-slot-0').click();
  await expect(slots).toHaveCount(1);

  // The rest by hand: the last letter answers the card, right but helped.
  await buildTiles(page, WORD.form);
  await expect(page.getByTestId('feedback-other')).toBeVisible();
  await expect(page.getByTestId('feedback-title')).toHaveText('נכון, עם עזרה');
  await expect(page.getByTestId('feedback-line')).toHaveCount(0);
  await page.getByTestId('continue-button').click();

  // 2. Phase 63 (spec D7, D12). On the choice, help rules out a wrong option a
  // press, down to two, then is spent; the right option after it is right with
  // help. The reverse card, unhelped, is right.
  const choice = await readCard(page, 3, total, 'choice');
  const ruledOut = page.locator('[data-testid^="option-"][aria-disabled="true"]');
  await expect(ruledOut).toHaveCount(0);
  await page.getByTestId('choice-help').click();
  await expect(ruledOut).toHaveCount(1);
  await page.getByTestId('choice-help').click();
  await expect(ruledOut).toHaveCount(2);
  await expect(page.getByTestId('choice-help')).toBeDisabled();
  await answerChoice(page, choice, true);
  await expect(page.getByTestId('feedback-other')).toBeVisible();
  await expect(page.getByTestId('feedback-title')).toHaveText('נכון, עם עזרה');
  await page.getByTestId('continue-button').click();
  await answerChoice(page, await readCard(page, 4, total, 'reverse'), true);
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await page.getByTestId('continue-button').click();

  // 3. The typed card, on a phone-sized screen (phase 63, spec D2): help sits
  // inside the answer box, in view. עזרה twice gives two letters, in grey where
  // the typing goes; the input itself stays empty.
  await page.setViewportSize({ width: 390, height: 844 });
  const typed = await readCard(page, 5, total, 'typed');
  expect(typed.prompt).toBe(WORD.translation);
  // The answer bar (answer bar spec D1): on a screen as short as a phone's above
  // its keyboard, the question, the input and בדיקה all show, unscrolled.
  await page.setViewportSize({ width: 390, height: 360 });
  await expect(page.getByTestId('question-prompt')).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId('typed-input')).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId('typed-submit')).toBeInViewport({ ratio: 1 });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('typed-box').getByTestId('typed-help')).toBeInViewport();
  await expect(page.getByTestId('typed-hint')).toHaveCount(0);
  await expect(page.getByTestId('typed-help')).toContainText('עזרה');
  await page.getByTestId('typed-help').click();
  await expect(page.getByTestId('typed-hint')).toHaveText(`${letters[0]}…`);
  await page.getByTestId('typed-help').click();
  await expect(page.getByTestId('typed-hint')).toHaveText(`${letters[0]}${letters[1]}…`);
  const input = page.getByTestId('typed-input');
  await expect(input).toHaveValue('');
  // The grey letters stand where the placeholder was: it goes while they show.
  await expect(input).not.toHaveAttribute('placeholder', /התשובה/);

  // Phase 63 (spec D3). Help reads the typing: after a wrong letter the grey goes,
  // nothing is marked until help is pressed, which marks it and gives nothing;
  // the mark goes with the next edit, and a right start brings the grey back.
  const wrongLetter = [...'абвгдежзиклмн'].find((letter) => letter !== letters[1])!;
  await input.fill(`${letters[0]}${wrongLetter}`);
  await expect(page.getByTestId('typed-hint')).toHaveCount(0);
  await page.getByTestId('typed-help').click();
  await expect(page.getByTestId('typed-marks')).toHaveText(wrongLetter);
  await expect(page.getByTestId('typed-ghost')).toHaveCount(0);
  await input.fill(letters[0]);
  await expect(page.getByTestId('typed-marks')).toHaveCount(0);
  await expect(page.getByTestId('typed-ghost')).toHaveText(`${letters[1]}…`);
  await input.fill('');

  // A wrong word opens the retype, not the banner: the right answer and the
  // notice, and the word is said, as a banner would say it.
  const banner = page.getByTestId(/^(continue-button|feedback-(correct|wrong|other))$/);
  const before = (await spoken(page)).length;
  await answerTyped(page, WRONG);
  await expect(page.getByTestId('retype')).toBeVisible();
  await expect.poll(async () => (await spoken(page)).slice(before)).toEqual([{ text: WORD.form, lang: 'ru-RU' }]);
  await expect(page.getByTestId('retype-title')).toHaveText('התשובה הנכונה:');
  await expect(page.getByTestId('retype-answer')).toHaveText(WORD.form);
  await expect(page.getByTestId('retype-notice')).toHaveText('הקלידו את המילה שוב');
  await expect(input).toHaveValue('');
  await expect(input).toBeEditable();
  await expect(banner).toHaveCount(0);
  // No way round it: no help, no hint, no show-answer.
  await expect(page.getByTestId('typed-help')).toHaveCount(0);
  await expect(page.getByTestId('typed-hint')).toHaveCount(0);
  await expect(page.getByTestId('typed-show-answer')).toHaveCount(0);

  // The first character typed hides the answer.
  await input.fill(WRONG[0]);
  await expect(page.getByTestId('retype-answer')).toHaveCount(0);
  await expect(page.getByTestId('retype-notice')).toHaveText('הקלידו את המילה שוב');

  // A wrong retype shows it again, with נסו שוב.
  await answerTyped(page, WRONG);
  await expect(page.getByTestId('retype-answer')).toHaveText(WORD.form);
  await expect(page.getByTestId('retype-notice')).toHaveText('נסו שוב');
  await expect(input).toHaveValue('');
  await expect(banner).toHaveCount(0);

  // The right word ends it: נכון! and המשך, and the word is not said again.
  // Sent by Return from the answer bar, as בדיקה would send it.
  await input.fill(WORD.form);
  await input.press('Enter');
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await expect(page.getByTestId('feedback-title')).toHaveText('נכון!');
  // Answer bar spec D5: the bar goes, and the answer, locked, shows in the card.
  await expect(input).not.toBeEditable();
  await expect(input).toHaveValue(WORD.form);
  await expect(page.getByTestId('retype')).toHaveCount(0);
  expect((await spoken(page)).slice(before)).toEqual([{ text: WORD.form, lang: 'ru-RU' }]);
  await page.getByTestId('continue-button').click();

  // 4. Five answers sent, each card's first: the tiles', the choice's and the
  // typed card's say they were helped (phase 63, spec D10: a choice too), and no
  // retype went to the server.
  await expect(page.getByTestId('results-score')).toBeVisible();
  expect(sent).toEqual([
    { question_id: expect.any(String), seen: true },
    { question_id: expect.any(String), text: WORD.form, helped: true },
    { question_id: expect.any(String), option_index: expect.any(Number), helped: true },
    { question_id: expect.any(String), option_index: expect.any(Number), helped: false },
    { question_id: expect.any(String), text: WRONG, helped: true },
  ]);

  // The three helped cards are wrong, the reverse card right, the meet card no part of it.
  expect(stripIsolates(await page.getByTestId('results-score').textContent())).toBe('1 / 4');
  await expect(page.getByTestId('missed-row')).toHaveCount(1);
  await expect(page.getByTestId('missed-row')).toContainText(WORD.form);

  expect(diagnostics.pageErrors, report()).toEqual([]);
});

// Review M5. A wrong tile alone makes the card helped: no help pressed, the right
// tiles after it, and the answer is sent helped and told right with help.
test('a wrong tile alone makes the tiles card helped', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  const sent: unknown[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/next-step$/.test(req.url())) sent.push(req.postDataJSON());
  });
  await startSession(page, request, 'e2e_help_tile_ru', report);

  await readCard(page, 1, 5, 'meet');
  await continueMeet(page);
  await readCard(page, 2, 5, 'tiles');
  const letters = tileLetters(WORD.form)!;

  // One wrong tap, then every letter by hand: the help button is never pressed.
  const wrong = (await tilesOnScreen(page)).findIndex((letter) => letter !== letters[0]);
  await page.getByTestId(`tile-${wrong}`).click();
  await expect(page.getByTestId('tiles-wrong')).toHaveText('לא האות הזאת');
  await expect(page.getByTestId(/^tile-slot-\d+$/)).toHaveCount(0);
  await buildTiles(page, WORD.form);

  await expect(page.getByTestId('feedback-other')).toBeVisible();
  await expect(page.getByTestId('feedback-title')).toHaveText('נכון, עם עזרה');
  await expect(page.getByTestId('feedback-line')).toHaveCount(0);
  await expect.poll(() => sent.length).toBe(2);
  expect(sent).toEqual([
    { question_id: expect.any(String), seen: true },
    { question_id: expect.any(String), text: WORD.form, helped: true },
  ]);

  expect(diagnostics.pageErrors, report()).toEqual([]);
});
