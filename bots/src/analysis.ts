import { gradesFor, retrievability, review, type Dimension, type MemoryState, type QuestionType } from '@lang-tutor/core/domain';

// The server's own rules, imported rather than copied: (d) asks whether the server's rung agrees
// with the level and R its rule implies, and a copy could drift from the rule it checks. These
// three modules are pure domain code that imports only @lang-tutor/core.
import { R_TARGET, RUNG_R } from '../../apps/server/src/domain/chooseConstants';
import { RUNGS } from '../../apps/server/src/domain/plan';
import { evaluateSession, type AnsweredQuestion, type ProgressRow } from '../../apps/server/src/domain/progress';

import type { BotMemory } from './memory.ts';
import type { BotState, CardEntry, SavedEntry } from './state.ts';

/**
 * Spec D21. The five numbers, per bot per simulated week, from the log and the hidden memory.
 * Pure: the caller hands in the memory, already set to the end of the week.
 *
 * "The tested dimension" of a card is the dimension the picker chose it for. The server does not
 * say which, so it is read back from the card's type through D6's rung table. Two types serve two
 * dimensions (dictation: SP at rung 1 or SR at rung 2; typed translation and typed cloze: WP or
 * SP at rung 2); for those, the dimension is the one D5 would have chosen from the server's
 * memory at the time, which `serverView` replays from the log.
 */

/** Below this true recall a word is weak in a dimension (D21 a). */
export const WEAK_P = 0.7;
/** A word whose weakest dimension is this far below its best has a weak dimension (D21 b). */
export const WEAK_GAP = 0.2;
export const DAYS_PER_WEEK = 7;

/** Days 1 to 7 are week 1, 8 to 14 week 2, and so on. */
export const weekOf = (day: number) => Math.ceil(day / DAYS_PER_WEEK);
/** The week's last day: the run that plays it closes the week (D22). */
export const isLastDayOfWeek = (day: number) => day % DAYS_PER_WEEK === 0;
const firstDayOf = (week: number) => (week - 1) * DAYS_PER_WEEK + 1;
const lastDayOf = (week: number) => week * DAYS_PER_WEEK;
const inWeek = (day: number, week: number) => day >= firstDayOf(week) && day <= lastDayOf(week);

/** D5's introduction order, easiest first. */
const ORDER: readonly Dimension[] = ['written_receptive', 'written_productive', 'spoken_receptive', 'spelling', 'spoken_productive'];

/** D5's LIVE: the written dimensions, and the spoken ones the device allows, in ORDER. */
export function liveDimensions(devices: { listening: boolean; speaking: boolean }): Dimension[] {
  return ORDER.filter(
    (d) => (d !== 'spoken_receptive' || devices.listening) && (d !== 'spoken_productive' || devices.speaking),
  );
}

export type Rung = 1 | 2;

/** A card as the server chose it: its dimension and rung, and the level and R it chose by. */
export type CardView = { dimension: Dimension; rung: Rung; level: number; r: number | null; implied: Rung };

/** The dimensions and rungs a card type can serve (D6). The board is made of multiple-choice picks. */
function servedBy(type: QuestionType): { dimension: Dimension; rung: Rung }[] {
  if (type === 'matching') return [{ dimension: 'written_receptive', rung: 1 }];
  const out: { dimension: Dimension; rung: Rung }[] = [];
  for (const dimension of ORDER) {
    RUNGS[dimension].forEach((types, i) => {
      if (types.includes(type)) out.push({ dimension, rung: (i + 1) as Rung });
    });
  }
  return out;
}

/** D6's rung rule, as the server applies it: recall only from level 3 with R at least RUNG_R. */
const impliedRung = (level: number, r: number | null): Rung => (r !== null && level >= 3 && r >= RUNG_R ? 2 : 1);

const CHOICE_TYPES: ReadonlySet<QuestionType> = new Set(['multiple_choice', 'reverse_choice', 'listen_choice', 'matching', 'cloze_choice']);

function answered(entry: CardEntry & { word: string }): AnsweredQuestion {
  if (CHOICE_TYPES.has(entry.type)) {
    return { glossId: entry.word, type: entry.type as Extract<AnsweredQuestion, { correct: boolean }>['type'], correct: entry.correct };
  }
  return {
    glossId: entry.word,
    type: entry.type as Extract<AnsweredQuestion, { verdict: unknown }>['type'],
    verdict: entry.verdict ?? (entry.correct ? 'exact' : 'wrong'),
  };
}

const DIMENSION_LIST: readonly Dimension[] = ORDER;

/**
 * The server's side of every card, index for index with the log; null for an unmatched card.
 * Replays what the server keeps, from the verdicts in the log: FSRS memory (D4: the session's
 * grades in order, written when it ends, on its day) and levels (the step rule, per session).
 * Each card is then placed on a dimension and given the level and R the server chose it by.
 */
export function serverView(log: readonly CardEntry[]): (CardView | null)[] {
  const memory = new Map<string, MemoryState>();
  const levels = new Map<string, ProgressRow>();
  const key = (word: string, dimension: Dimension) => `${word}|${dimension}`;
  const view: (CardView | null)[] = [];

  let start = 0;
  while (start < log.length) {
    let end = start;
    while (end < log.length && log[end].session === log[start].session) end++;
    const session = log.slice(start, end);
    const date = session[0].date;

    for (const entry of session) {
      if (entry.word === null) {
        view.push(null);
        continue;
      }
      const word = entry.word;
      const options = servedBy(entry.type);
      if (options.length === 0) {
        view.push(null);
        continue;
      }
      const rOf = (dimension: Dimension) => {
        const state = memory.get(key(word, dimension));
        return state ? retrievability(state, date) : null;
      };
      const withR = options.map((o) => ({ ...o, r: rOf(o.dimension) }));
      const known = withR.filter((o) => o.r !== null).sort((x, y) => x.r! - y.r!);
      // D5: the weakest dimension when it is due, else the next one to introduce, else the weakest.
      const chosen =
        (known.length > 0 && known[0].r! <= R_TARGET ? known[0] : undefined) ??
        withR.find((o) => o.r === null) ??
        known[0];
      const level = levels.get(key(word, chosen.dimension))?.level ?? 1;
      view.push({ dimension: chosen.dimension, rung: chosen.rung, level, r: chosen.r, implied: impliedRung(level, chosen.r) });
    }

    const matched = session.filter((e): e is CardEntry & { word: string } => e.word !== null);
    for (const entry of matched) {
      for (const { dimension, grade } of gradesFor({ type: entry.type, correct: entry.correct, verdict: entry.verdict })) {
        const k = key(entry.word, dimension);
        memory.set(k, review(memory.get(k) ?? null, grade, date));
      }
    }
    const words = [...new Set(matched.map((e) => e.word))];
    const rows = words.flatMap((word) =>
      DIMENSION_LIST.map(
        (dimension) =>
          levels.get(key(word, dimension)) ?? { glossId: word, dimension, level: 1, lastStepOn: null, lastWrongOn: null },
      ),
    );
    const { changed } = evaluateSession(rows, matched.map(answered), date);
    for (const row of changed) levels.set(key(row.glossId, row.dimension), row);

    start = end;
  }
  return view;
}

/** Median of a list; null when empty. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** (e): mean true recall over every word saved by `lastDay` and every live dimension; null with none. */
export function meanRecall(
  memory: BotMemory,
  saved: readonly SavedEntry[],
  live: readonly Dimension[],
  lastDay: number,
): number | null {
  const values = saved.filter((w) => w.day <= lastDay).flatMap((w) => live.map((d) => memory.recall(w.form, d)));
  return values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length;
}

/** Median gaps in days for the second, third, and fourth-or-later reviews right in a row. */
export type Intervals = { second: number | null; third: number | null; later: number | null };

export type WeekNumbers = {
  week: number;
  /** The week's matched cards: what the numbers are counted over. */
  cards: number;
  /** Weak words get the practice: above 1 is what the choosing is for. */
  a: number | null;
  /** Weak dimensions get their cards. */
  b: number | null;
  /** Intervals grow. */
  c: Intervals;
  /** Difficulty fits the level: low is good. */
  d: number | null;
  /** The bot remembers more. Null when the week was closed after later days were played: the
   *  memory at its end is gone. */
  e: number | null;
  /** Closed after later days were played (a run that failed to close it). */
  late?: true;
};

/**
 * D21's five numbers for `week`. `memory` is the bot's hidden memory, set to the end of the week;
 * `live` its live dimensions.
 */
export function weekNumbers(state: BotState, week: number, memory: BotMemory, live: readonly Dimension[]): WeekNumbers {
  const view = serverView(state.log);
  const cards = state.log
    .map((entry, i) => ({ entry, view: view[i] }))
    .filter((c): c is { entry: CardEntry; view: CardView } => c.view !== null && inWeek(c.entry.day, week));

  // (a) The share of cards on a word weak in the tested dimension, over the weak share of the
  // list: (saved word, live dimension) pairs below WEAK_P at the start of each session (DayLine).
  const judged = cards.filter((c) => c.entry.recall[c.view.dimension] !== undefined);
  const weakCards = judged.filter((c) => c.entry.recall[c.view.dimension]! < WEAK_P).length;
  const days = state.days.filter((d) => inWeek(d.day, week));
  const pairs = days.reduce((s, d) => s + (d.listPairs ?? 0), 0);
  const weakPairs = days.reduce((s, d) => s + (d.listWeak ?? 0), 0);
  const a = judged.length > 0 && weakPairs > 0 ? weakCards / judged.length / (weakPairs / pairs) : null;

  // (b) Cards on a word whose weakest live dimension is WEAK_GAP or more below its best, at the
  // card: the share whose tested dimension is that weakest one.
  let eligible = 0;
  let onWeakest = 0;
  for (const { entry, view: v } of cards) {
    const known = live.filter((d) => entry.recall[d] !== undefined);
    if (known.length < 2) continue;
    // The first of equals in ORDER, as the picker introduces them.
    const weakest = known.reduce((lo, d) => (entry.recall[d]! < entry.recall[lo]! ? d : lo));
    const best = Math.max(...known.map((d) => entry.recall[d]!));
    if (best - entry.recall[weakest]! < WEAK_GAP) continue;
    eligible += 1;
    if (v.dimension === weakest) onWeakest += 1;
  }
  const b = eligible > 0 ? onWeakest / eligible : null;

  // (c) Per word and dimension, over the whole log so a run can span weeks: the gap to the
  // previous review, for this week's reviews that are the 2nd, 3rd, 4th+ right in a row.
  const runs = new Map<string, { streak: number; lastDay: number }>();
  const gaps: Record<keyof Intervals, number[]> = { second: [], third: [], later: [] };
  state.log.forEach((entry, i) => {
    const v = view[i];
    if (!v || entry.word === null) return;
    const k = `${entry.word}|${v.dimension}`;
    const before = runs.get(k);
    const streak = entry.correct ? (before?.streak ?? 0) + 1 : 0;
    if (before && streak >= 2 && inWeek(entry.day, week)) {
      gaps[streak === 2 ? 'second' : streak === 3 ? 'third' : 'later'].push(entry.day - before.lastDay);
    }
    runs.set(k, { streak, lastDay: entry.day });
  });
  const c = { second: median(gaps.second), third: median(gaps.third), later: median(gaps.later) };

  // (d) Cards whose rung is not the one the level and R imply.
  const d = cards.length > 0 ? cards.filter((x) => x.view.rung !== x.view.implied).length / cards.length : null;

  const e = meanRecall(memory, state.saved, live, lastDayOf(week));

  return { week, cards: cards.length, a, b, c, d, e };
}
