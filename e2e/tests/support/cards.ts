import { tileLetters } from '@lang-tutor/core/domain';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

import { MOST_CARDS, expectGeminiByTask } from './mockServer';
import { continueMeet } from './sessions';
import { stripIsolates } from './text';

/** Wrong Hebrew meanings for today's card. None is a right answer anywhere. */
export const WRONG_HEBREW = ['דלת', 'קיר', 'תקרה'];
/** Wrong Russian words for a reversed card. None is a saved form or lemma. */
export const WRONG_RUSSIAN = ['писать', 'дверь', 'стена'];

export type CardKind = 'meet' | 'choice' | 'reverse' | 'typed' | 'listen' | 'dictation' | 'tiles' | 'board' | 'read' | 'say' | 'meaning' | 'cloze-choice' | 'cloze-typed' | 'translate' | 'new-meaning';

export type Card = { kind: CardKind; prompt: string; options: string[] };

const HEBREW = /\p{Script=Hebrew}/u;

/** The kind of the card on screen, from what it renders. */
async function kindOnScreen(page: Page): Promise<CardKind> {
  const has = async (id: string) => (await page.getByTestId(id).count()) > 0;
  // Phase 54. A new word's first card: its title is on no other card.
  if (await has('meet-title')) return 'meet';
  if (await has('board')) return 'board';
  if (await has('tiles')) return 'tiles';
  if (await has('listen-play')) return (await has('typed-input')) ? 'dictation' : 'listen';
  if (await has('speak-record')) {
    const prompt = stripIsolates(await page.getByTestId('question-prompt').textContent());
    return HEBREW.test(prompt) ? 'say' : 'read';
  }
  if (await has('meaning-card')) return 'meaning';
  if (await has('cloze-card')) return (await has('typed-input')) ? 'cloze-typed' : 'cloze-choice';
  if (await has('translate-card')) return 'translate';
  if (await has('new-meaning-card')) return 'new-meaning';
  if (await has('typed-input')) return 'typed';
  const prompt = stripIsolates(await page.getByTestId('question-prompt').textContent());
  return HEBREW.test(prompt) ? 'reverse' : 'choice';
}

/**
 * The card at `position` of `total`, read once the counter shows it, and
 * checked against `expected` when one is given. Phase 35: which type a
 * position gets follows from the learner's memory (spec D6), so a spec that
 * steers it seeds memory (memory.ts) and reads the type from the screen.
 */
export async function readCard(page: Page, position: number, total: number, expected?: CardKind): Promise<Card> {
  await expect(page.getByTestId('progress-label')).toHaveText(new RegExp(`${position}\\s*/\\s*${total}`));
  const kind = await kindOnScreen(page);
  if (expected) expect(kind, `position ${position}`).toBe(expected);
  const prompt =
    (await page.getByTestId('question-prompt').count()) > 0
      ? stripIsolates(await page.getByTestId('question-prompt').textContent())
      : '';
  const options =
    kind === 'choice' || kind === 'new-meaning' || kind === 'reverse' || kind === 'listen' || kind === 'cloze-choice'
      ? await Promise.all([0, 1, 2, 3].map(async (i) => stripIsolates(await page.getByTestId(`option-${i}`).textContent())))
      : [];
  return { kind, prompt, options };
}

/** The words on a board, in order. Phase 34 (spec D10): each button also shows
 *  the word's part of speech under it, `board-word-<i>-note`, which is not the word. */
export async function boardWords(page: Page): Promise<string[]> {
  return Promise.all(
    [0, 1, 2, 3].map(async (i) => {
      const text = stripIsolates(await page.getByTestId(`board-word-${i}`).textContent());
      const note = page.getByTestId(`board-word-${i}-note`);
      const part = (await note.count()) > 0 ? stripIsolates(await note.textContent()) : '';
      return text.endsWith(part) ? text.slice(0, text.length - part.length).trim() : text;
    }),
  );
}

/** Phase 27 Part B. The one sentence every stubbed `sentence` and `translate`
 *  answer uses, in Russian with its Hebrew: it holds `STUB_GAP` once, and
 *  whichever saved word a position asks, a gap is any word of the sentence
 *  with as many words as the saved form (one). The gap is inflected, so its
 *  lemma is a word that is not in the sentence. */
export const STUB_SENTENCE = 'Вчера она прочитала эту книгу';
// Phase 59 (spec D1): five words, the most a sentence to translate keeps.
export const STUB_SENTENCE_HEBREW = 'אתמול היא קראה את הספר';
export const STUB_GAP = 'прочитала';
export const STUB_GAP_LEMMA = 'прочитать';

/** Phase 35. What the generation stub answers for each task the job can ask
 *  (domain/distractors.ts taskFor), whichever position asks it: Hebrew wrong
 *  options for a choice of meanings (and a board's), Russian ones for a choice
 *  of words or of a gap, `alternatives` for a typed card, and the one stub
 *  sentence for a gap to choose (phase 62), a gap to type and a sentence to translate. Phase 38:
 *  `gapAlternatives`, the words that also fit the typed gap. */
export function generationStub(alternatives: string[] = [], gapAlternatives: string[] = []): Record<string, Record<string, unknown>> {
  return {
    meaning: { distractors: WRONG_HEBREW },
    word: { distractors: WRONG_RUSSIAN },
    // Phase 62 (spec D1): a gap to choose writes its own sentence, the stub's.
    gap: { distractors: WRONG_RUSSIAN, sentence: STUB_SENTENCE, gap: STUB_GAP, translation: STUB_SENTENCE_HEBREW },
    typed: { distractors: [], alternatives },
    sentence: { distractors: [], sentence: STUB_SENTENCE, gap: STUB_GAP, translation: STUB_SENTENCE_HEBREW, alternatives: gapAlternatives },
    translate: { distractors: [], sentence: STUB_SENTENCE_HEBREW, gap: STUB_GAP, translation: STUB_SENTENCE },
  };
}

/** Registers the generation stub: every position's item answered by its task,
 *  for as many positions as a list session holds. */
export async function expectGeneration(request: APIRequestContext, alternatives: string[] = [], gapAlternatives: string[] = []): Promise<void> {
  await expectGeminiByTask(request, generationStub(alternatives, gapAlternatives), MOST_CARDS);
}

/** Whether an option is one of the stub's wrong words. Case-blind: a gap's wrong
 *  words take the blank's capital (6252eb8), so a sentence-initial gap offers
 *  "Стена" for the stub's "стена". Hebrew has no case, so this changes nothing there. */
function isStubWrong(card: Card, text: string): boolean {
  const wrong = card.kind === 'reverse' || card.kind === 'cloze-choice' ? WRONG_RUSSIAN : WRONG_HEBREW;
  return wrong.includes(text.toLowerCase());
}

/** Picks the right option (the one not in the stub's wrong list) or a wrong one. */
export async function answerChoice(page: Page, card: Card, right: boolean) {
  const index = card.options.findIndex((text) => isStubWrong(card, text) !== right);
  expect(index, card.options.join(' | ')).toBeGreaterThanOrEqual(0);
  await page.getByTestId(`option-${index}`).click();
  return card.options[index];
}

/**
 * Phase 54. Plays the card on screen to its end, for a spec about what comes
 * after it: a meet card is tapped through; a choice of meanings, of words or of
 * a new meaning is answered right; a typed card is shown its answer. Then it
 * moves on. Phase 55 (spec D7): so is a tiles card; a typed translation shown
 * its answer is typed again, from the answer it shows, before its banner.
 * Phase 56 (spec D7): so is a typed meaning, a dictation and a typed gap; a
 * sentence translation has no retype.
 */
export async function playOut(page: Page, card: Card) {
  if (card.kind === 'meet') return continueMeet(page);
  if (card.kind === 'choice' || card.kind === 'reverse' || card.kind === 'new-meaning') await answerChoice(page, card, true);
  else if (card.kind === 'tiles') await page.getByTestId('tiles-show-answer').click();
  else if (card.kind === 'typed' || card.kind === 'meaning' || card.kind === 'dictation' || card.kind === 'cloze-typed' || card.kind === 'translate') {
    await page.getByTestId('typed-show-answer').click();
    await retypeIfOpen(page);
  } else throw new Error(`no way to play a ${card.kind} card out`);
  await page.getByTestId('continue-button').click();
}

/** Phase 56 (spec D7). After an answer that may open a retype — wrong, nearly
 *  right or "show the answer" on a typed card — waits for the retype or the
 *  banner, and ends a retype right, so the banner is up either way. */
export async function retypeIfOpen(page: Page) {
  const retype = page.getByTestId('retype');
  await expect(retype.or(page.getByTestId('continue-button'))).toBeVisible();
  if (await retype.isVisible()) await retypeShown(page);
}

/** Types an answer on a typed card and checks it. Phase 55 (spec D7): in a
 *  retype, the same input and button check the word typed again. */
export async function answerTyped(page: Page, text: string) {
  await page.getByTestId('typed-input').fill(text);
  await page.getByTestId('typed-submit').click();
}

/** Phase 55 (spec D7). Ends an open retype right: types the answer it shows,
 *  and waits for the banner, which says נכון!. */
export async function retypeShown(page: Page) {
  const answer = stripIsolates(await page.getByTestId('retype-answer').textContent());
  await answerTyped(page, answer);
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
}

/** Phase 55 (spec D7). Ends an open retype wrong: two wrong words, then the
 *  banner, which names the right answer. */
export async function retypeWrong(page: Page, wrong: string) {
  await expect(page.getByTestId('retype-notice')).toHaveText('הקלידו את המילה שוב');
  await answerTyped(page, wrong);
  await expect(page.getByTestId('retype-notice')).toHaveText('נסו שוב');
  await expect(page.getByTestId('typed-input')).toHaveValue('');
  await answerTyped(page, wrong);
  await expect(page.getByTestId('feedback-wrong')).toBeVisible();
}

/** Phase 55. The letters of a tiles card's pool, in tile order. */
export async function tilesOnScreen(page: Page): Promise<string[]> {
  const count = await page.getByTestId(/^tile-\d+$/).count();
  return Promise.all(Array.from({ length: count }, async (_, i) => stripIsolates(await page.getByTestId(`tile-${i}`).textContent())));
}

/**
 * Phase 55 (spec D7). Builds `word` on the tiles card on screen: taps the tile
 * for each letter not placed yet, and waits for the card to answer itself once
 * the last is placed. Each letter takes the first unused tile with it, as the
 * card's help does, so a letter help placed is skipped like any other.
 */
export async function buildTiles(page: Page, word: string) {
  const letters = tileLetters(word);
  expect(letters, `${word} takes no tiles`).not.toBeNull();
  const pool = await tilesOnScreen(page);
  const placed = await page.getByTestId(/^tile-slot-\d+$/).count();
  const used = new Set<number>();
  for (const [slot, letter] of letters!.entries()) {
    const index = pool.findIndex((tile, i) => tile === letter && !used.has(i));
    expect(index, `a tile for ${letter}`).toBeGreaterThanOrEqual(0);
    used.add(index);
    if (slot >= placed) await page.getByTestId(`tile-${index}`).click();
  }
  await expect(page.getByTestId('continue-button')).toBeVisible();
}

/** The right option's text: the word on a reversed card, the meaning on today's. */
export function rightOption(card: Card): string {
  return card.options.find((text) => !isStubWrong(card, text))!;
}

/** One swap of the second and third letters: a near miss on five letters or more. */
export function nearMiss(word: string): string {
  const letters = [...word];
  [letters[1], letters[2]] = [letters[2], letters[1]];
  return letters.join('');
}

/** Phase 25. Records one attempt on the speaking card: tap, about a second of
 *  Chromium's fake microphone, tap. */
export async function speak(page: Page) {
  // Retried: a click before the static export hydrates is a silent no-op, and
  // the first card of a session can be this one (phase 27; by p since phase 35).
  await expect(async () => {
    // Only while nothing is recording: a second tap would stop the recording
    // a slow recorder.start() has just begun.
    if ((await page.getByTestId('speak-status').count()) === 0) await page.getByTestId('speak-record').click();
    await expect(page.getByTestId('speak-status')).toBeVisible({ timeout: 4_000 });
  }).toPass({ timeout: 20_000 });
  await page.waitForTimeout(1_000);
  await page.getByTestId('speak-record').click();
}

/** Phase 27. Answers a meaning card. The stored meaning is judged by rule, with
 *  no model call, and since phase 31 so are the gloss key and the stored
 *  alternatives of the card's rendering and gloss; anything else needs an
 *  expectJudge stub first. */
export async function answerMeaning(page: Page, text: string) {
  await page.getByTestId('typed-input').fill(text);
  await page.getByTestId('typed-submit').click();
}
