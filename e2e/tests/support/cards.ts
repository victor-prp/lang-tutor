import { expect, type Page } from '@playwright/test';

import { stripIsolates } from './text';

/** Wrong Hebrew meanings for today's card. None is a right answer anywhere. */
export const WRONG_HEBREW = ['דלת', 'קיר', 'תקרה'];
/** Wrong Russian words for a reversed card. None is a saved form or lemma. */
export const WRONG_RUSSIAN = ['писать', 'дверь', 'стена'];

/** The type cycle by position (server domain/session.ts, spec D2). */
export const CYCLE = ['choice', 'reverse', 'typed'] as const;
export type CardKind = 'choice' | 'reverse' | 'typed' | 'listen' | 'dictation' | 'tiles' | 'board' | 'read' | 'say' | 'meaning' | 'cloze-choice' | 'cloze-typed' | 'translate';

/**
 * Phase 23. The generation stub for q1 to q10, each key answering the task of
 * its position: Hebrew wrong options for today's card, Russian ones for a
 * reversed card, no options and `alternatives` for a typed card.
 */
export function generationStub(alternatives: string[] = []) {
  return {
    items: Array.from({ length: 10 }, (_, i) => {
      const key = `q${i + 1}`;
      switch (CYCLE[i % 3]) {
        case 'choice':
          return { key, distractors: WRONG_HEBREW };
        case 'reverse':
          return { key, distractors: WRONG_RUSSIAN };
        case 'typed':
          return { key, distractors: [], alternatives };
      }
    }),
  };
}

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
 * checked against `expected`: by default phase 23's cycle, which a session of
 * four words at ordinal 0 with no voices still follows (phase 24 plan).
 */
export async function readCard(
  page: Page,
  position: number,
  total: number,
  expected: CardKind = CYCLE[(position - 1) % 3],
): Promise<Card> {
  await expect(page.getByTestId('progress-label')).toHaveText(new RegExp(`${position}\\s*/\\s*${total}`));
  const kind = await kindOnScreen(page);
  expect(kind, `position ${position}`).toBe(expected);
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

/** Phase 27 Part B. The one sentence every stubbed `sentence` and `translate`
 *  answer uses, in Russian with its Hebrew: it holds `STUB_GAP` once, and
 *  whichever saved word a position asks, a gap is any word of the sentence
 *  with as many words as the saved form (one). The gap is inflected, so its
 *  lemma is a word that is not in the sentence. */
export const STUB_SENTENCE = 'Вчера она прочитала эту книгу';
export const STUB_SENTENCE_HEBREW = 'אתמול היא קראה את הספר הזה';
export const STUB_GAP = 'прочитала';
export const STUB_GAP_LEMMA = 'прочитать';

type Task = 'meaning' | 'word' | 'typed' | 'gap' | 'sentence' | 'translate';

/** Phase 24. A stub answering exactly the keys a plan asks, each by its task. */
export function generationStubFor(tasks: Record<number, Task>, alternatives: string[] = []) {
  return {
    items: Object.entries(tasks).map(([position, task]) => {
      const key = `q${position}`;
      switch (task) {
        case 'meaning':
          return { key, distractors: WRONG_HEBREW };
        case 'word':
        case 'gap':
          return { key, distractors: WRONG_RUSSIAN };
        case 'typed':
          return { key, distractors: [], alternatives };
        case 'sentence':
          return { key, distractors: [], sentence: STUB_SENTENCE, gap: STUB_GAP, translation: STUB_SENTENCE_HEBREW, alternatives: [] };
        case 'translate':
          return { key, distractors: [], sentence: STUB_SENTENCE_HEBREW, gap: STUB_GAP, translation: STUB_SENTENCE };
      }
    }),
  };
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
  // the first card of a session can be this one (the rotation, phase 27).
  await expect(async () => {
    // Only while nothing is recording: a second tap would stop the recording
    // a slow recorder.start() has just begun.
    if ((await page.getByTestId('speak-status').count()) === 0) await page.getByTestId('speak-record').click();
    await expect(page.getByTestId('speak-status')).toBeVisible({ timeout: 4_000 });
  }).toPass({ timeout: 20_000 });
  await page.waitForTimeout(1_000);
  await page.getByTestId('speak-record').click();
}

/** Phase 27. Answers a meaning card. The stored meaning is judged by rule,
 *  with no model call; anything else needs an expectJudge stub first. */
export async function answerMeaning(page: Page, text: string) {
  await page.getByTestId('typed-input').fill(text);
  await page.getByTestId('typed-submit').click();
}
