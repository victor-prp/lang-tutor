import type { CreateTargetRequest, Target, TargetKind, TargetList, VocabularyEntryInput } from '@lang-tutor/core/api';
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
 * played sessions played then: its creation, its words' joining and starting, its finished
 * sessions' practice day, and (phase 65) its days' budgets and readiness. A target whose day
 * was done is then resting today, until the plan's next practice day: nothing is owed and
 * nothing was practised today.
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
      // Phase 65 (spec D2, D7.2): the day's budget and readiness, recorded by the day too.
      await tx.execute(sql`update target_budgets set day = day - ${days}::int where target_id = ${targetId}`);
      await tx.execute(sql`
        update target_readiness set day = day - ${days}::int, last_day = last_day - ${days}::int
        where target_id = ${targetId}`);
      await tx.execute(sql`update target_readiness_events set day = day - ${days}::int where target_id = ${targetId}`);
    });
  } finally {
    await handle.close();
  }
}

/** Phase 67 (spec D2). Makes every readiness row of a target as sure as can be (a stability of ten
 *  thousand days): its answered words are ready, so before the eve they rest. */
export async function makeTargetReady(targetId: string): Promise<void> {
  const handle = createDb(E2E_DATABASE_URL, { max: 1, onError: () => {} });
  try {
    await handle.db.execute(sql`update target_readiness set stability = 10000 where target_id = ${targetId}`);
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

const READINESS_FOR: Record<TargetKind, string> = { homework: 'לשיעורי הבית', exam: 'לבוחן' };

/**
 * Phase 65 (spec D4, D5). A target's readiness where `scope` draws it, a home card or the target
 * screen's header: the big number, what a screen reader says of it, and the gain on its bar since
 * the start of today ("+13% היום"), none before an answer today.
 */
export async function expectReadiness(
  scope: Locator,
  target: Pick<Target, 'id' | 'kind' | 'readiness_pct' | 'readiness_start_pct'>,
): Promise<void> {
  await expectLabel(scope.getByTestId('target-readiness-big'), `${target.readiness_pct}%`);
  await expect
    .poll(async () => stripIsolates(await scope.getByTestId(`target-readiness-${target.id}`).getAttribute('aria-label')))
    .toBe(`מוכנות ${READINESS_FOR[target.kind]}: ${target.readiness_pct}%`);
  const gain = target.readiness_pct - target.readiness_start_pct;
  await expectLabel(scope.getByTestId('target-readiness-gain'), gain === 0 ? '' : `${gain > 0 ? '+' : '−'}${Math.abs(gain)}% היום`);
}

/** Today's sessions as `expectSessions` reads them: the line, the line under it (none: null or
 *  absent), the words beside it (none: null), and each dot's kind (done, todo, faded, bonus).
 *  Phase 71: on the eve, each word's bar too, in order (ready, short). */
export type SessionsView = { line: string; sub?: string | null; side: string | null; dots: string[]; bars?: string[] };

/** Phase 71 (spec D4). The eve's words row: the words below their bar, the ready ones beside them,
 *  no session dots, and a bar a word, the ready ones first. */
export const eveOf = (target: Pick<Target, 'word_count' | 'ready_count' | 'word_readiness'>): SessionsView => {
  const missing = target.word_count - target.ready_count;
  return {
    line: missing === 1 ? 'עוד מילה אחת לחזק' : `עוד ${missing} מילים לחזק`,
    side: `${target.ready_count} מתוך ${target.word_count} מוכנות`,
    dots: [],
    bars: [...target.word_readiness].sort((a, b) => b - a).map((pct) => (pct >= 100 ? 'ready' : 'short')),
  };
};
/** Phase 71 (spec D5). The eve's strip while a word is below its bar. */
export const eveStrip = (kind: Target['kind']) => `${kind === 'exam' ? 'הבוחן' : 'שיעורי הבית'} מחר · היום מתרגלים עד שכל המילים מוכנות`;

/** The word bars' testID prefix (phase 71): each bar's kind follows it (`target-word-bar-ready`). */
const BAR = 'target-word-bar-';

/** Phase 65 (spec D5, D7), phase 67b (spec D7). The day's goal before its first session, about how
 *  long it takes, and a dot to do per session. */
export const offerOf = (today: Target['today']): SessionsView => ({
  line: today.sessions_offer === 1 ? 'היעד של היום: תרגול אחד' : `היעד של היום: ${today.sessions_offer} תרגולים`,
  side: `כ-${today.minutes} דקות`,
  dots: Array<string>(today.sessions_offer).fill('todo'),
});

/** Phase 67b (spec D7, Victor). The day's line once its goal is met (or its work done before it,
 *  "4 במקום 5" beside it): blue while another session can raise the card, green once nothing can
 *  today, and "you did it" at 100%. */
export const MET_MORE = { line: 'עשית עבודה טובה להיום ↑', sub: 'עוד כמה תרגולים יחזקו עוד יותר' } as const;
export const MET_DONE = { line: 'עשית עבודה מצוינת להיום ✓', sub: 'מחר נחזק עוד' } as const;
export const ALL_READY = { line: 'עשית את זה! ✓', sub: null } as const;
/** The met line a target's summary calls for. */
export const metOf = (target: Pick<Target, 'practice_more_little' | 'readiness_pct'>) =>
  target.readiness_pct >= 100 ? ALL_READY : target.practice_more_little ? MET_DONE : MET_MORE;
const PRAISE: ReadonlySet<string> = new Set([MET_MORE.line, MET_DONE.line, ALL_READY.line]);

/** The dots' testID prefix: each dot's kind follows it (`target-session-dot-done`). The dots are
 *  hidden from a screen reader, which reads the row's own label instead. */
const DOT = 'target-session-dot-';

/**
 * Phase 65 (spec D5, D7). Today's sessions where `scope` draws them: the line (the praise once the
 * day is done, which is where target-praise-<id> sits), what is beside it, the dots, and that the
 * dots are hidden from a screen reader while the row has a label of its own.
 */
export async function expectSessions(scope: Locator, targetId: string, view: SessionsView): Promise<void> {
  const line = scope.getByTestId(PRAISE.has(view.line) ? `target-praise-${targetId}` : `target-today-${targetId}`);
  await expectLabel(line, view.line);
  const sub = scope.getByTestId(`target-sessions-${targetId}-sub`);
  if (view.sub == null) await expect(sub).toHaveCount(0);
  else await expectLabel(sub, view.sub);
  const side = scope.getByTestId(`target-sessions-${targetId}-side`);
  if (view.side === null) await expect(side).toHaveCount(0);
  else await expectLabel(side, view.side);
  const row = scope.getByTestId(`target-sessions-${targetId}`);
  await expect
    .poll(() =>
      row
        .locator(`[data-testid^="${DOT}"]`)
        .evaluateAll((dots, prefix) => dots.map((dot) => dot.getAttribute('data-testid')!.slice(prefix.length)), DOT),
    )
    .toEqual(view.dots);
  if (view.bars !== undefined) {
    await expect
      .poll(() =>
        row
          .locator(`[data-testid^="${BAR}"]`)
          .evaluateAll((bars, prefix) => bars.map((bar) => bar.getAttribute('data-testid')!.slice(prefix.length)), BAR),
      )
      .toEqual(view.bars);
  }
  await expect(row.getByTestId('target-sessions')).toHaveAttribute('aria-hidden', 'true');
  // "תרגול" covers one session ("תרגול אחד", phase 67b) and many ("תרגולים"); a row with no dots
  // (a rest day at 100%) says its line alone.
  await expect(row).toHaveAttribute('aria-label', view.dots.length > 0 ? /תרגול|בונוס/ : /\S/);
}

/** The target screen's header (phase 65, spec D6): the countdown and what sits beside it. Home stays
 *  mounted under the screen with the same card ids, so the screen's lines are read inside it. */
export const screenHeader = (page: Page): Locator => page.getByTestId('target-countdown').locator('..');

/** Two words of the learner's own list and six of a homework's: single-sense Russian nouns
 *  shared with other specs (lexemes.ts), so a lookup another spec stored is the same. */
export const MY_WORDS: readonly Word[] = BOARD_WORDS.slice(0, 2);
export const HOMEWORK_WORDS: readonly Word[] = BOARD_WORDS.slice(2, 8);
export const EVERY_WORD: readonly Word[] = [...MY_WORDS, ...HOMEWORK_WORDS];

/**
 * A learner past the seed, on a device with no voice and no microphone (so a word's live
 * skills are the written three, and its writing card asks spelling too), with MY_WORDS of their
 * own and a homework of HOMEWORK_WORDS due in 40 days: the plan meets its words over the days to
 * its halfway point (phase 67, spec D3), so one is owed today, met by its ladder, and five come
 * later. Each path's session is stocked as the words come (spec D2), so the generation is stubbed
 * before.
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
  expect(formsOf(target, 'owed'), JSON.stringify(target.words)).toHaveLength(1);
  expect(formsOf(target, 'later')).toHaveLength(5);
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
