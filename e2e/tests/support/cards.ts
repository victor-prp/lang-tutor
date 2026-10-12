import { SESSION_LENGTH } from '@lang-tutor/core/domain';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

import { expectGeminiByTask } from './mockServer';
import { stripIsolates } from './text';

/** Wrong Hebrew meanings for today's card. None is a right answer anywhere. */
export const WRONG_HEBREW = ['דלת', 'קיר', 'תקרה'];
/** Wrong Russian words for a reversed card. None is a saved form or lemma. */
export const WRONG_RUSSIAN = ['писать', 'дверь', 'стена'];

export type CardKind = 'choice' | 'reverse' | 'typed' | 'listen' | 'dictation' | 'tiles' | 'board' | 'read' | 'say' | 'meaning' | 'cloze-choice' | 'cloze-typed' | 'translate';

export type Card = { kind: CardKind; prompt: string; options: string[] };

const HEBREW = /\p{Script=Hebrew}/u;

/** The kind of the card on screen, from what it renders. */
async function kindOnScreen(page: Page): Promise<CardKind> {
  const has = async (id: string) => (await page.getByTestId(id).count()) > 0;
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
    kind === 'choice' || kind === 'reverse' || kind === 'listen' || kind === 'cloze-choice'
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
export const STUB_SENTENCE_HEBREW = 'אתמול היא קראה את הספר הזה';
export const STUB_GAP = 'прочитала';
export const STUB_GAP_LEMMA = 'прочитать';

/** Phase 35. What the generation stub answers for each task the job can ask
 *  (domain/distractors.ts taskFor), whichever position asks it: Hebrew wrong
 *  options for a choice of meanings (and a board's), Russian ones for a choice
 *  of words or of a gap, `alternatives` for a typed card, and the one stub
 *  sentence for a gap to type and a sentence to translate. Phase 38:
 *  `gapAlternatives`, the words that also fit the typed gap. */
export function generationStub(alternatives: string[] = [], gapAlternatives: string[] = []): Record<string, Record<string, unknown>> {
  return {
    meaning: { distractors: WRONG_HEBREW },
    word: { distractors: WRONG_RUSSIAN },
    gap: { distractors: WRONG_RUSSIAN },
    typed: { distractors: [], alternatives },
    sentence: { distractors: [], sentence: STUB_SENTENCE, gap: STUB_GAP, translation: STUB_SENTENCE_HEBREW, alternatives: gapAlternatives },
    translate: { distractors: [], sentence: STUB_SENTENCE_HEBREW, gap: STUB_GAP, translation: STUB_SENTENCE },
  };
}

/** Registers the generation stub: every position's item answered by its task,
 *  for as many positions as a list session holds. */
export async function expectGeneration(request: APIRequestContext, alternatives: string[] = [], gapAlternatives: string[] = []): Promise<void> {
  await expectGeminiByTask(request, generationStub(alternatives, gapAlternatives), SESSION_LENGTH);
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

/** Types an answer on a typed card and checks it. */
export async function answerTyped(page: Page, text: string) {
  await page.getByTestId('typed-input').fill(text);
  await page.getByTestId('typed-submit').click();
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
