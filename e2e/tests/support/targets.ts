import type { CreateTargetRequest, Target, TargetList, VocabularyEntryInput } from '@lang-tutor/core/api';
import { sql } from 'drizzle-orm';
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { createDb } from '../../../apps/server/src/db/client';
import { E2E_DATABASE_URL } from '../../globalSetup';
import { API_URL } from '../../urls';
import {
  answerChoice,
  answerMeaning,
  answerTyped,
  buildTiles,
  expectGeneration,
  readCard,
  rightOption,
  STUB_GAP,
  STUB_SENTENCE,
  type Card,
} from './cards';
import { BOARD_WORDS } from './lexemes';
import { expectGeminiMatching, expectJudge, userText } from './mockServer';
import { continueMeet, enrollmentIdOf, skipSeed } from './sessions';
import { stripIsolates } from './text';
import { signUpLearner } from './users';
import { withVoices } from './voices';

// Phase 57 (spec D1, D10–D12). A target's own path, end to end: the words a spec saves and a
// target holds, made over the API as the signed-in learner (pass `page.request`), and what
// home and the target screen show of it.

/** One saved word: its form, its Hebrew meaning and the lookup that answers it. */
export type Word = { form: string; translation: string; payload: unknown };

/** What a response said, for a failure's message. A 204 has no body to give. */
const bodyOf = (res: { text(): Promise<string> }) => res.text().catch(() => '');

async function read<T>(request: APIRequestContext, path: string): Promise<T> {
  const res = await request.get(`${API_URL}${path}`);
  if (!res.ok()) throw new Error(`GET ${path} answered ${res.status()}: ${await bodyOf(res)}`);
  return (await res.json()) as T;
}

/** The learner's day plus `days`, as the API writes a day. */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Looks each word up over the API, each answered by a stub matched on its own text, and
 * answers the entries a save or a target takes, in the words' order. A stub left registered
 * matches nothing else: a lookup's user part is the word alone. Before expectGeneration:
 * MockServer tries stubs of one priority in the order they came, and the generation's
 * answers any call.
 */
export async function lookUpEntries(
  request: APIRequestContext,
  enrollmentId: string,
  words: readonly Word[],
): Promise<VocabularyEntryInput[][]> {
  const entries: VocabularyEntryInput[][] = [];
  for (const word of words) {
    await expectGeminiMatching(request, userText(word.form), word.payload);
    const lookup = await request.post(`${API_URL}/api/translations`, {
      data: { text: word.form, from: 'ru', to: 'he', enrollment_id: enrollmentId },
    });
    expect(lookup.ok(), await bodyOf(lookup)).toBe(true);
    const { senses } = (await lookup.json()) as { senses: { gloss_id?: string; variant_id?: string }[] };
    entries.push(senses.map((sense) => ({ gloss_id: sense.gloss_id!, variant_id: sense.variant_id! })));
  }
  return entries;
}

/** Saves entries to the learner's list: the main path's words ("My words"). */
export async function saveEntries(request: APIRequestContext, enrollmentId: string, entries: VocabularyEntryInput[]): Promise<void> {
  const saved = await request.post(`${API_URL}/api/enrollments/${enrollmentId}/vocabulary`, { data: { entries } });
  expect(saved.ok(), await bodyOf(saved)).toBe(true);
}

/** Creates a target holding `entries` (saved with it), as the wizard's Done does. */
export async function createTarget(
  request: APIRequestContext,
  enrollmentId: string,
  body: Pick<CreateTargetRequest, 'kind' | 'due_on' | 'entries'>,
): Promise<Target> {
  const res = await request.post(`${API_URL}/api/enrollments/${enrollmentId}/targets`, {
    data: { photo_import_ids: [], ...body },
  });
  if (res.status() !== 201) throw new Error(`create target answered ${res.status()}: ${await bodyOf(res)}`);
  return (await res.json()) as Target;
}

export const readTargets = (request: APIRequestContext, enrollmentId: string) =>
  read<TargetList>(request, `/api/enrollments/${enrollmentId}/targets`);
export const readTarget = (request: APIRequestContext, targetId: string) => read<Target>(request, `/api/targets/${targetId}`);

/** The forms of a target's words whose day is `today`, sorted. */
export const formsOf = (target: Target, today: Target['words'][number]['today']) =>
  target.words
    .filter((word) => word.today === today)
    .map((word) => word.form)
    .sort();

/**
 * Phase 57 (spec D10). Brings a target's date to today, straight in this lane's e2e
 * database: the API refuses a date that is not after today, and a spec cannot wait a day.
 */
export async function moveDueDateToToday(targetId: string, today: string): Promise<void> {
  const handle = createDb(E2E_DATABASE_URL, { max: 1, onError: () => {} });
  try {
    await handle.db.execute(sql`update targets set due_on = ${today} where id = ${targetId}`);
  } finally {
    await handle.close();
  }
}

/**
 * Phase 57 (spec D6). Moves a target back `days` days, as if it had been made then and its
 * played sessions played then: its creation, its words' joining and starting, and its
 * finished sessions' practice day. A target whose day was done is then resting today, until
 * the plan's next practice day: nothing is owed and nothing was practised today.
 */
export async function moveTargetBack(targetId: string, days: number): Promise<void> {
  const handle = createDb(E2E_DATABASE_URL, { max: 1, onError: () => {} });
  const back = `${days} days`;
  try {
    await handle.db.transaction(async (tx) => {
      await tx.execute(sql`update targets set created_at = created_at - ${back}::interval where id = ${targetId}`);
      await tx.execute(sql`
        update target_words
        set added_at = added_at - ${back}::interval, started_on = started_on - ${days}::int
        where target_id = ${targetId}`);
      await tx.execute(sql`
        update sessions set practice_day = practice_day - ${days}::int
        where target_id = ${targetId} and practice_day is not null`);
    });
  } finally {
    await handle.close();
  }
}

/** Home's path cards, in the order home stacks them: `main` for My words, else the target's
 *  id. Phase 64 (spec D3): one card shows at a time, so the order is the bars' (phase 64b); a
 *  stack of one has no bars, and the order is the one card on show. */
export async function homeOrder(page: Page): Promise<string[]> {
  const bars = await page
    .locator('[data-testid^="home-bar-"]:visible')
    .evaluateAll((found) => found.map((bar) => bar.getAttribute('data-testid') ?? ''));
  if (bars.length > 0) return bars.map((id) => id.slice('home-bar-'.length));
  const ids = await page
    .locator('[data-testid="home-my-words"]:visible, [data-testid^="target-card-"]:visible')
    .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-testid') ?? ''));
  return ids.map((id) => (id === 'home-my-words' ? 'main' : id.slice('target-card-'.length)));
}

/** Phase 64 (spec D3), phase 64b (spec D4). Brings one of home's cards into view by its named
 *  bar, as a finger or a mouse would: `main` for My words, else the target's id. */
export async function showCard(page: Page, card: string): Promise<void> {
  const bar = page.getByTestId(`home-bar-${card}`);
  await bar.click();
  await expect(bar).toHaveAttribute('aria-selected', 'true');
}

/** A label's text with its isolates gone, once it reads `text`. */
export async function expectLabel(locator: Locator, text: string): Promise<void> {
  await expect.poll(async () => stripIsolates(await locator.textContent()), { timeout: 15_000 }).toBe(text);
}

/** Two words of the learner's own list and six of a homework's: single-sense Russian nouns
 *  shared with other specs (lexemes.ts), so a lookup another spec stored is the same. */
export const MY_WORDS: readonly Word[] = BOARD_WORDS.slice(0, 2);
export const HOMEWORK_WORDS: readonly Word[] = BOARD_WORDS.slice(2, 8);
export const EVERY_WORD: readonly Word[] = [...MY_WORDS, ...HOMEWORK_WORDS];

/**
 * A learner past the seed, on a device with no voice and no microphone (so a word's live
 * skills are the written three), with MY_WORDS of their own and a homework of HOMEWORK_WORDS
 * due in 40 days: the plan starts a third of its words on its first day (spec D6), so two
 * are owed today and four come later, and the cap is the far one, which a new word's ladder
 * answered right reaches. Each path's session is stocked as the words come (spec D2), so the
 * generation is stubbed before.
 */
export async function homework(page: Page, request: APIRequestContext, username: string) {
  await withVoices(page, []);
  await signUpLearner(page, username, 'ru');
  const enrollmentId = await enrollmentIdOf(page.request);
  await skipSeed(page.request, enrollmentId);
  const [first, second, ...homeworkEntries] = await lookUpEntries(page.request, enrollmentId, EVERY_WORD);
  await expectGeneration(request);
  await saveEntries(page.request, enrollmentId, [...first, ...second]);
  const { today } = await readTargets(page.request, enrollmentId);
  const target = await createTarget(page.request, enrollmentId, {
    kind: 'homework',
    due_on: addDays(today, 40),
    entries: homeworkEntries.flat(),
  });
  expect(formsOf(target, 'owed'), JSON.stringify(target.words)).toHaveLength(2);
  expect(formsOf(target, 'later')).toHaveLength(4);
  return { enrollmentId, target };
}

/** The colour of a filled button (colors.primary); phase 64 (spec D4): the other is pale blue
 *  (colors.primarySurface). */
export const FILLED = 'rgb(59, 91, 219)';
export const OUTLINED = 'rgb(238, 242, 251)';

/** The session's length, from the counter on its first card. */
async function sessionLength(page: Page): Promise<number> {
  const counter = page.getByTestId('progress-label');
  await expect(counter).toHaveText(/1\s*\/\s*\d+/);
  const total = /\/\s*(\d+)/.exec(stripIsolates(await counter.textContent()))?.[1];
  return Number(total);
}

/** The form the session on screen asks first: its first card meets a new word (phase 54),
 *  and shows its form. */
export async function firstForm(page: Page): Promise<string> {
  const card = await readCard(page, 1, await sessionLength(page), 'meet');
  return card.prompt;
}

/**
 * Plays the session on screen to its end, every card answered right with no help, and
 * answers the forms each card asked (a sentence card's gap is the stub's, so it names none).
 * A target's values move only on right answers with no help (spec D4).
 */
export async function playSessionRight(page: Page, request: APIRequestContext, words: readonly Word[]): Promise<string[]> {
  const formOf = new Map(words.map((word) => [word.translation, word.form]));
  const translationOf = new Map(words.map((word) => [word.form, word.translation]));
  // The card's word, from the form it shows or the meaning it asks for; one the spec did not
  // save fails the card.
  const byForm = (card: Card, form: string) => {
    if (!translationOf.has(form)) throw new Error(`a ${card.kind} card asked a word no one saved: ${card.prompt}`);
    return form;
  };
  const byTranslation = (card: Card, translation: string) => byForm(card, formOf.get(translation) ?? translation);

  const total = await sessionLength(page);
  const asked: string[] = [];
  for (let position = 1; position <= total; position++) {
    const card = await readCard(page, position, total);
    if (card.kind === 'meet') {
      asked.push(byForm(card, card.prompt));
      await continueMeet(page);
      continue;
    }
    if (card.kind === 'choice' || card.kind === 'new-meaning') {
      asked.push(byForm(card, card.prompt));
      await answerChoice(page, card, true);
    } else if (card.kind === 'reverse') {
      asked.push(byForm(card, rightOption(card)));
      await answerChoice(page, card, true);
    } else if (card.kind === 'cloze-choice') {
      await answerChoice(page, card, true);
    } else if (card.kind === 'tiles') {
      const form = byTranslation(card, card.prompt);
      asked.push(form);
      await buildTiles(page, form);
    } else if (card.kind === 'typed') {
      const form = byTranslation(card, card.prompt);
      asked.push(form);
      await answerTyped(page, form);
    } else if (card.kind === 'meaning') {
      const form = byForm(card, card.prompt);
      asked.push(form);
      await answerMeaning(page, translationOf.get(form)!);
    } else if (card.kind === 'cloze-typed') {
      await answerTyped(page, STUB_GAP);
    } else if (card.kind === 'translate') {
      await expectJudge(request, 'right');
      await answerTyped(page, STUB_SENTENCE);
    } else {
      throw new Error(`no way to answer a ${card.kind} card right`);
    }
    await expect(page.getByTestId('feedback-correct'), `position ${position}: ${card.kind} ${card.prompt}`).toBeVisible();
    await page.getByTestId('continue-button').click();
  }
  await expect(page.getByTestId('results-score')).toBeVisible();
  return asked;
}
