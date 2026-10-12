import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { answerChoice, answerMeaning, answerTyped, expectGeneration, readCard } from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { lookUp, tapAndWaitForWrite, tapUntil } from './support/interactions';
import { BOARD_WORDS, LUK, PROCHITALA } from './support/lexemes';
import { seedMemory } from './support/memory';
import { clearGemini, expectGeminiMatching, userText } from './support/mockServer';
import { openApp, signUpLearner } from './support/users';
import { spokenAfter, spoken, withVoices } from './support/voices';

test.setTimeout(240_000);

// Phase 39 (spec D8, D9). A typed answer in the wrong alphabet is asked again on
// the phone: the notice shows, the text stays, nothing is sent and no banner
// appears. The language an instruction names is set in bold.

const WRONG_ALPHABET_FOR_RUSSIAN = 'מציצה';
const MEANINGS_OF: Record<string, string[]> = { прочитала: ['קראה', 'הקריאה'], лук: ['בצל', 'קשת'] };

const MEANING_CARDS = 2;

async function expectBoldLanguage(page: Page) {
  await expect(page.getByTestId('instruction-language')).toHaveCSS('font-weight', '700');
}

async function expectAskedAgain(page: Page, typed: string) {
  await expect(page.getByTestId('wrong-script')).toBeVisible();
  // A refusal in the app's error colour (colors.wrong), its language still bold.
  await expect(page.getByTestId('wrong-script-language')).toHaveCSS('color', 'rgb(201, 42, 42)');
  await expect(page.getByTestId('wrong-script-language')).toHaveCSS('font-weight', '700');
  await expect(page.getByTestId('typed-input')).toHaveValue(typed);
  await expect(page.getByTestId('feedback-correct')).not.toBeVisible();
  await expect(page.getByTestId('feedback-wrong')).not.toBeVisible();
}

/** Past a skipped seed, four single-meaning words saved through the API. */
async function saveWords(request: APIRequestContext, count: number): Promise<void> {
  const enrollments = (await (await request.get(`${API_URL}/api/enrollments`)).json()) as { id: string }[];
  const enrollmentId = enrollments[0].id;
  const seed = (await (await request.post(`${API_URL}/api/sessions`, { data: { enrollment_id: enrollmentId } })).json()) as {
    session_id: string;
  };
  expect((await request.post(`${API_URL}/api/sessions/${seed.session_id}/skip`)).ok()).toBe(true);
  for (const word of BOARD_WORDS.slice(-count)) {
    await clearGemini(request);
    await expectGeminiMatching(request, userText(word.form), word.payload);
    const lookup = await request.post(`${API_URL}/api/translations`, {
      data: { text: word.form, from: 'ru', to: 'he', enrollment_id: enrollmentId },
    });
    expect(lookup.ok(), await lookup.text()).toBe(true);
    const { senses } = (await lookup.json()) as { senses: { gloss_id?: string; variant_id?: string }[] };
    const saved = await request.post(`${API_URL}/api/enrollments/${enrollmentId}/vocabulary`, {
      data: { entries: senses.map((sense) => ({ gloss_id: sense.gloss_id!, variant_id: sense.variant_id! })) },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
  }
}

test('a dictation: Hebrew in a Russian answer is asked again, then the right word is answered', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  page.on('dialog', (dialog) => void dialog.accept());
  await withVoices(page, ['ru-RU']);
  await signUpLearner(page, 'e2e_script_dictation_ru', 'ru');
  // The last four of the ten words: the lizard (ящерица) is due on spoken
  // recognition, so it is asked as a dictation; the other three are new.
  await saveWords(page.request, 4);
  await seedMemory('e2e_script_dictation_ru', [{ gloss: 'לטאה', dimension: 'spoken_receptive', stability: 10, daysAgo: 19, level: 3 }]);

  await clearGemini(request);
  await expectGeneration(request);
  // Phase 43 (spec D7). Home makes the session itself: it lands on the switcher, then offers start.
  await openApp(page, 'enrollment-switcher');
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  let before = (await spoken(page)).length;
  await tapUntil(page, 'start-button', 'progress-label');

  for (let position = 1; position <= 4; position++) {
    const card = await readCard(page, position, 4);
    if (card.kind === 'dictation') {
      const dictated = await spokenAfter(page, before);
      await expectBoldLanguage(page);
      await answerTyped(page, WRONG_ALPHABET_FOR_RUSSIAN);
      await expectAskedAgain(page, WRONG_ALPHABET_FOR_RUSSIAN);
      // Typing again clears the notice; the right word is answered.
      await answerTyped(page, dictated.text);
      await expect(page.getByTestId('wrong-script')).not.toBeVisible();
      await expect(page.getByTestId('feedback-correct')).toBeVisible();
      expect(diagnostics.pageErrors, report()).toEqual([]);
      return;
    }
    expect(card.kind, `position ${position}`).toBe('choice');
    await answerChoice(page, card, true);
    before = (await spoken(page)).length;
    await page.getByTestId('continue-button').click();
  }
  throw new Error(`the session asked no dictation\n${report()}`);
});

test('a meaning card: Latin in a Hebrew answer is asked again, then the meaning is answered', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  page.on('dialog', (dialog) => void dialog.accept());
  await withVoices(page, []);
  await signUpLearner(page, 'e2e_script_meaning_ru', 'ru');
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
  await seedMemory('e2e_script_meaning_ru', [{ gloss: 'בצל', dimension: 'written_receptive', stability: 10, daysAgo: 19, level: 3 }]);

  await clearGemini(request);
  await expectGeneration(request);
  // Phase 43 (spec D7). Home makes the session itself, so the memory and the
  // stubs are in place before going back.
  await page.getByTestId('translate-back').click();
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');

  // Each word's two senses are a gloss family, asked once a session: two cards.
  for (let position = 1; position <= MEANING_CARDS; position++) {
    const card = await readCard(page, position, MEANING_CARDS);
    if (card.kind === 'meaning') {
      await expectBoldLanguage(page);
      await answerMeaning(page, 'book');
      await expectAskedAgain(page, 'book');
      await answerMeaning(page, MEANINGS_OF[card.prompt][0]);
      await expect(page.getByTestId('wrong-script')).not.toBeVisible();
      await expect(page.getByTestId('feedback-correct')).toBeVisible();
      expect(diagnostics.pageErrors, report()).toEqual([]);
      return;
    }
    expect(card.kind, `position ${position}`).toBe('choice');
    await answerChoice(page, card, true);
    await page.getByTestId('continue-button').click();
  }
  throw new Error(`the session asked no meaning card\n${report()}`);
});
