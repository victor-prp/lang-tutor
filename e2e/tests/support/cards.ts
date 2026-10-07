import { expect, type Page } from '@playwright/test';

import { stripIsolates } from './text';

/** Wrong Hebrew meanings for today's card. None is a right answer anywhere. */
export const WRONG_HEBREW = ['דלת', 'קיר', 'תקרה'];
/** Wrong Russian words for a reversed card. None is a saved form or lemma. */
export const WRONG_RUSSIAN = ['писать', 'дверь', 'стена'];

/** The type cycle by position (server domain/session.ts, spec D2). */
export const CYCLE = ['choice', 'reverse', 'typed'] as const;
export type CardKind = 'choice' | 'reverse' | 'typed' | 'listen' | 'dictation' | 'tiles' | 'board' | 'read' | 'say' | 'meaning';

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
    kind === 'choice' || kind === 'reverse' || kind === 'listen'
      ? await Promise.all([0, 1, 2, 3].map(async (i) => stripIsolates(await page.getByTestId(`option-${i}`).textContent())))
      : [];
  return { kind, prompt, options };
}

/** Phase 24. A stub answering exactly the keys a plan asks, each by its task. */
export function generationStubFor(tasks: Record<number, 'meaning' | 'word' | 'typed'>, alternatives: string[] = []) {
  return {
    items: Object.entries(tasks).map(([position, task]) => {
      const key = `q${position}`;
      if (task === 'meaning') return { key, distractors: WRONG_HEBREW };
      if (task === 'word') return { key, distractors: WRONG_RUSSIAN };
      return { key, distractors: [], alternatives };
    }),
  };
}

/** Picks the right option (the one not in the stub's wrong list) or a wrong one. */
export async function answerChoice(page: Page, card: Card, right: boolean) {
  const wrong = card.kind === 'reverse' ? WRONG_RUSSIAN : WRONG_HEBREW;
  const index = card.options.findIndex((text) => wrong.includes(text) !== right);
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
  const wrong = card.kind === 'reverse' ? WRONG_RUSSIAN : WRONG_HEBREW;
  return card.options.find((text) => !wrong.includes(text))!;
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
  await page.getByTestId('speak-record').click();
  await expect(page.getByTestId('speak-status')).toBeVisible();
  await page.waitForTimeout(1_000);
  await page.getByTestId('speak-record').click();
}

/** Phase 27. Answers a meaning card. The stored meaning is judged by rule,
 *  with no model call; anything else needs an expectJudge stub first. */
export async function answerMeaning(page: Page, text: string) {
  await page.getByTestId('typed-input').fill(text);
  await page.getByTestId('typed-submit').click();
}
