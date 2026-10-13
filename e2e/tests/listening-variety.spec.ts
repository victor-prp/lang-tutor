import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { answerTyped, boardWords, expectGeneration, readCard, type Card, type CardKind } from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { tapUntil } from './support/interactions';
import { BOARD_WORDS } from './support/lexemes';
import { seedMemory, type MemorySeed } from './support/memory';
import { clearGemini, expectGeminiMatching, userText } from './support/mockServer';
import { stripIsolates } from './support/text';
import { openApp, signUpLearner } from './support/users';
import { spoken, spokenAfter, withVoices } from './support/voices';

test.setTimeout(240_000);

const MEANING_OF: Record<string, string> = Object.fromEntries(BOARD_WORDS.map((w) => [w.form, w.translation]));
const FORM_OF: Record<string, string> = Object.fromEntries(BOARD_WORDS.map((w) => [w.translation, w.form]));

/** Past a skipped seed, with the ten words looked up and saved through the API. */
async function saveTenWords(request: APIRequestContext): Promise<void> {
  const enrollments = (await (await request.get(`${API_URL}/api/enrollments`)).json()) as { id: string }[];
  const enrollmentId = enrollments[0].id;
  const seed = (await (await request.post(`${API_URL}/api/sessions`, { data: { enrollment_id: enrollmentId } })).json()) as {
    session_id: string;
  };
  expect((await request.post(`${API_URL}/api/sessions/${seed.session_id}/skip`)).ok()).toBe(true);
  for (const word of BOARD_WORDS) {
    await clearGemini(request);
    // Phase 31. Matched on its own text, as lookUp's is: a background render-lemma
    // job from an earlier spec's save may still be calling, and a stub that
    // answered every call would write this word under that lemma.
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

/** Builds the word on a tiles card from its tiles. */
async function buildFromTiles(page: Page, card: Card) {
  const count = await page.getByTestId(/^tile-\d+$/).count();
  const tiles = await Promise.all(Array.from({ length: count }, async (_, i) => (await page.getByTestId(`tile-${i}`).textContent()) ?? ''));
  const used = new Set<number>();
  for (const letter of FORM_OF[card.prompt]) {
    const index = tiles.findIndex((tile, i) => tile === letter && !used.has(i));
    expect(index, `tile for ${letter}`).toBeGreaterThanOrEqual(0);
    used.add(index);
    await page.getByTestId(`tile-${index}`).click();
  }
  await page.getByTestId('tiles-submit').click();
}

/**
 * Phase 35 (spec D5, D6). The memory that gives ten words a listening card, a
 * board, tiles, a typed card, a meaning card and a dictation. A ru-RU voice and
 * speaking off, so the live dimensions are WR, WP, SR and SP. Each seeded word
 * is due on the one dimension it has a row for:
 * - ромашка, черепаха, подушка, зонтик: no memory, new words, a choice of
 *   meanings each; four of them in a session of seven picks or more make the
 *   board (ruling 18).
 * - ведро: SR at R 0.50 (S 1, 90 days), level 1: recognition, listen and choose.
 * - скрипка, лопата: WP at R 0.72 (S 10, 75 days), level 1: recognition. Tiles'
 *   p is √0.72 = 0.849, nearer 0.85 than a choice of words' 0.25 + 0.75·√0.72 =
 *   0.887, and with no saved example there is no gap to choose.
 * - кастрюля: WP at R 0.85 (S 10, 19 days), level 3: recall, the typed
 *   translation (first of three types at p = 0.85).
 * - фонарь: WR at R 0.85, level 3: recall, a typed meaning.
 * - ящерица: SR at R 0.85, level 3: recall, a dictation.
 * The cards come in the order of their p, so each is answered by its type.
 */
const MEMORY: MemorySeed[] = [
  { gloss: 'דלי', dimension: 'spoken_receptive', stability: 1, daysAgo: 90, level: 1 },
  { gloss: 'כינור', dimension: 'written_productive', stability: 10, daysAgo: 75, level: 1 },
  { gloss: 'את חפירה', dimension: 'written_productive', stability: 10, daysAgo: 75, level: 1 },
  { gloss: 'סיר', dimension: 'written_productive', stability: 10, daysAgo: 19, level: 3 },
  { gloss: 'פנס', dimension: 'written_receptive', stability: 10, daysAgo: 19, level: 3 },
  { gloss: 'לטאה', dimension: 'spoken_receptive', stability: 10, daysAgo: 19, level: 3 },
];

test('ten words: a listening card, a board, tiles and a dictation', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  page.on('dialog', (dialog) => void dialog.accept());
  await withVoices(page, ['ru-RU']);
  await signUpLearner(page, 'e2e_listen_ru', 'ru');
  await saveTenWords(page.request);
  await seedMemory('e2e_listen_ru', MEMORY);

  await clearGemini(request);
  await expectGeneration(request);
  // Phase 43 (spec D7). Home makes the session itself: it lands on the switcher, then offers start.
  await openApp(page, 'enrollment-switcher');
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  let before = (await spoken(page)).length;
  await tapUntil(page, 'start-button', 'progress-label');

  const kinds: CardKind[] = [];
  for (let position = 1; position <= 10; position++) {
    const card = await readCard(page, position, 10);
    kinds.push(card.kind);
    // Phase 44 (spec D1, D2): everything said since this card appeared. Each
    // branch below waits for the card's last cue, so `before` is settled when
    // it is read again for the next card.
    const said = async () => (await spoken(page)).slice(before);
    if (card.kind === 'listen') {
      // The word is spoken on arrival and not shown; pick its meaning.
      const heard = await spokenAfter(page, before);
      expect(heard.lang).toBe('ru-RU');
      await page.getByTestId(`option-${card.options.indexOf(MEANING_OF[heard.text])}`).click();
      await expect(page.getByTestId('feedback-correct')).toBeVisible();
      await expect(page.getByTestId('question-prompt')).toHaveText(heard.text);
      // Once per card (R7): nothing more after the answer.
      expect(await said()).toEqual([heard]);
    } else if (card.kind === 'tiles') {
      // Silent until checked: hearing the word would give it away.
      expect(await said()).toEqual([]);
      // Build the word from its tiles.
      await buildFromTiles(page, card);
      await expect(page.getByTestId('feedback-correct')).toBeVisible();
      // Then it says the word just built.
      await expect.poll(said).toEqual([{ text: FORM_OF[card.prompt], lang: 'ru-RU' }]);
    } else if (card.kind === 'typed') {
      // Silent until checked, then it says the right answer.
      expect(await said()).toEqual([]);
      await answerTyped(page, FORM_OF[card.prompt]);
      await expect(page.getByTestId('feedback-correct')).toBeVisible();
      await expect.poll(said).toEqual([{ text: FORM_OF[card.prompt], lang: 'ru-RU' }]);
    } else if (card.kind === 'board') {
      // The board: one wrong pairing for the first word, then every word right.
      const words = await boardWords(page);
      // Phase 34 (spec D10): each word says its part of speech, all nouns here.
      for (const i of [0, 1, 2, 3]) await expect(page.getByTestId(`board-word-${i}-note`)).toHaveText('שם עצם');
      const meanings = await Promise.all(
        [0, 1, 2, 3, 4].map(async (i) => stripIsolates(await page.getByTestId(`board-meaning-${i}`).textContent())),
      );
      // Phase 44 (spec D5): a tap on a word says it.
      const tapBoardWord = async (i: number) => {
        const n = (await spoken(page)).length;
        await page.getByTestId(`board-word-${i}`).click();
        expect(await spokenAfter(page, n)).toEqual({ text: words[i], lang: 'ru-RU' });
      };
      await tapBoardWord(0);
      await page.getByTestId(`board-meaning-${meanings.findIndex((m) => m !== MEANING_OF[words[0]])}`).click();
      for (const [i, word] of words.entries()) {
        await tapBoardWord(i);
        await page.getByTestId(`board-meaning-${meanings.indexOf(MEANING_OF[word])}`).click();
      }
      await expect(page.getByTestId('feedback-title')).toHaveText(/3\s*מתוך\s*4/);
      // The tapped words and nothing else: a meaning says nothing, and neither
      // does the board by itself.
      expect(await said()).toEqual([words[0], ...words].map((text) => ({ text, lang: 'ru-RU' })));
      // The board takes four positions.
      position += 3;
    } else if (card.kind === 'meaning') {
      // Meaning recall reads its word on arrival, with no tap.
      await expect.poll(said).toEqual([{ text: card.prompt, lang: 'ru-RU' }]);
      // Passed by showing the answer, after which it says nothing more (R7).
      await page.getByTestId('typed-show-answer').click();
      await expect(page.getByTestId('continue-button')).toBeVisible();
      expect(await said()).toEqual([{ text: card.prompt, lang: 'ru-RU' }]);
    } else {
      // Hear it, type it.
      expect(card.kind).toBe('dictation');
      const dictated = await spokenAfter(page, before);
      await answerTyped(page, dictated.text);
      await expect(page.getByTestId('feedback-correct')).toBeVisible();
      // Once per card (R7): nothing more after the answer.
      expect(await said()).toEqual([dictated]);
    }
    before = (await spoken(page)).length;
    await page.getByTestId('continue-button').click();
  }
  expect(kinds.sort()).toEqual(['board', 'dictation', 'listen', 'meaning', 'tiles', 'tiles', 'typed']);

  // Results: listening is practice now (spec D13).
  await expect(page.getByText(/הבנת הנשמע/).first(), report()).toBeVisible();
  expect(diagnostics.pageErrors, report()).toEqual([]);
});
