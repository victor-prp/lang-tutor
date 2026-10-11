import type { Dimension, QuestionType } from '@lang-tutor/core/domain';

import { expectedSuccess } from './choose';
import { CARD_TARGET } from './chooseConstants';
import { comparable } from './distractors';
import { READ_ALOUD_MAX_LEVEL } from './progress';

/**
 * Phase 35 (spec D6). Each pick's card, and the order a list session asks its
 * picks in. The words, each with a dimension and a rung, were chosen when the
 * session was created (D5); the type needs the word's form and saved example,
 * which only the preparation job reads. Pure and deterministic: the same picks
 * and flags give the same plan.
 */

/** One pick as the plan reads it. `tiles`: the form can be built from tiles.
 *  `speakable`: it is one to four words, so it can be said (phase 25 D3).
 *  `clozeGap`: its saved example holds the form exactly once, so it can be
 *  blanked (phase 27 D7). `dimension`, `rung`, `level` and `r` come from the
 *  word choice (D5): `r` is null for a dimension with no memory yet. */
export type PlanPick = {
  form: string;
  translation: string;
  tiles: boolean;
  speakable: boolean;
  clozeGap: boolean;
  dimension: Dimension;
  rung: 1 | 2;
  level: number;
  r: number | null;
};

/** `listening`: the app said its device has a voice for the target (phase 24 D5).
 *  `speaking`: the app said it can record (phase 25 D4). */
export type PlanInput = { listening: boolean; speaking: boolean };

/** `order[i]` is the index into the picks asked at position `i`, `types[i]`
 *  its type. A board takes positions `start` to `start + 3`. */
export type SessionPlan = { order: number[]; types: QuestionType[]; board: { start: number } | null };

/** Spec D6. Per dimension, the types of rung 1 (recognition) and rung 2 (recall),
 *  in the order a tie falls to. Matching is never chosen for a pick: the board
 *  is made from multiple-choice picks afterwards. */
export const RUNGS: Readonly<Record<Dimension, readonly [readonly QuestionType[], readonly QuestionType[]]>> = {
  written_receptive: [['multiple_choice'], ['typed_meaning']],
  written_productive: [
    ['reverse_choice', 'cloze_choice', 'letter_tiles'],
    ['typed_translation', 'cloze_typed', 'sentence_translation'],
  ],
  spelling: [['dictation'], ['typed_translation', 'cloze_typed']],
  spoken_receptive: [['listen_choice'], ['dictation']],
  spoken_productive: [['read_aloud'], ['say_translation']],
};

/** Spec D6: no type is chosen more than this many times in one session. A new
 *  word's multiple choice, and the last resort's, are not chosen and do not
 *  count: four new words would otherwise send every recognised word to recall,
 *  though those four are about to become a board. */
export const MAX_PER_TYPE = 4;

export const BOARD_SIZE = 4;

/** The cards with four options to pick from: a guess is right one time in four. */
const FOUR_OPTION: ReadonlySet<QuestionType> = new Set(['multiple_choice', 'reverse_choice', 'cloze_choice', 'listen_choice']);

const SPEAKING: ReadonlySet<QuestionType> = new Set(['read_aloud', 'say_translation']);

/** `speaking` is the session's: on, and more than one word (phase 25). */
function eligible(type: QuestionType, pick: PlanPick, listening: boolean, speaking: boolean): boolean {
  if (SPEAKING.has(type) && !speaking) return false;
  switch (type) {
    case 'multiple_choice':
    case 'reverse_choice':
    case 'typed_translation':
    case 'typed_meaning':
      return true;
    case 'listen_choice':
    case 'dictation':
      return listening;
    case 'letter_tiles':
      return pick.tiles;
    case 'read_aloud':
      // Spec D6: once, while SK is below the level a read aloud can reach. A
      // read aloud said right raises SK to that level and writes no memory, so
      // "unintroduced" alone would read it aloud every time.
      return pick.speakable && pick.level < READ_ALOUD_MAX_LEVEL;
    case 'say_translation':
    case 'cloze_typed':
    case 'sentence_translation':
      // Phase 27 (spec D9): the sentence cards practise the form in any
      // inflection, so only a form short enough to say is one a sentence fits.
      return pick.speakable;
    case 'cloze_choice':
      return pick.clozeGap;
    case 'matching':
      return false;
  }
}

// The same comparison the distractors use: points, stress, a full stop and case
// do not make two words different.
const key = comparable;

/** The first four of `candidates` (indices into `picks`) whose forms and
 *  meanings all differ: two senses of one word, or two words with one meaning,
 *  would each make two pairings right. Null when four cannot be found. */
function boardPicks(picks: readonly PlanPick[], candidates: readonly number[]): number[] | null {
  const taken: number[] = [];
  for (const i of candidates) {
    if (taken.length === BOARD_SIZE) break;
    const clash = taken.some(
      (j) => key(picks[j].form) === key(picks[i].form) || key(picks[j].translation) === key(picks[i].translation),
    );
    if (!clash) taken.push(i);
  }
  return taken.length === BOARD_SIZE ? taken : null;
}

type Card = { type: QuestionType; p: number };
/** `chosen`: picked from a rung, so it counts toward MAX_PER_TYPE. */
type Choice = Card & { chosen: boolean };

/** Spec D6. The eligible type of the rung whose chance is nearest CARD_TARGET;
 *  a tie goes to the type used least, then to the table's order. Null when the
 *  rung has no eligible type left. */
function bestIn(
  rung: 1 | 2,
  pick: PlanPick,
  used: ReadonlyMap<QuestionType, number>,
  listening: boolean,
  speaking: boolean,
): Card | null {
  let best: (Card & { distance: number; uses: number }) | null = null;
  for (const type of RUNGS[pick.dimension][rung - 1]) {
    const uses = used.get(type) ?? 0;
    if (uses >= MAX_PER_TYPE || !eligible(type, pick, listening, speaking)) continue;
    // The exponent is the rung the type sits in, also when it is the fallback rung.
    const p = expectedSuccess(pick.r, FOUR_OPTION.has(type), rung);
    const distance = Math.abs(p - CARD_TARGET);
    if (!best || distance < best.distance || (distance === best.distance && uses < best.uses)) {
      best = { type, p, distance, uses };
    }
  }
  return best && { type: best.type, p: best.p };
}

/** The pick's rung, then the other rung, then multiple choice, always
 *  eligible. A new word has no R and takes multiple choice (spec D6). */
function cardFor(pick: PlanPick, used: ReadonlyMap<QuestionType, number>, listening: boolean, speaking: boolean): Choice {
  const multipleChoice = { type: 'multiple_choice' as const, p: expectedSuccess(pick.r, true, 1), chosen: false };
  if (pick.dimension === 'written_receptive' && pick.r === null) return multipleChoice;
  const other = pick.rung === 1 ? 2 : 1;
  const card = bestIn(pick.rung, pick, used, listening, speaking) ?? bestIn(other, pick, used, listening, speaking);
  return card ? { ...card, chosen: true } : multipleChoice;
}

/** What the order places: one pick, or the board's four together. */
type Unit = { indices: number[]; type: QuestionType; p: number };

/** Whether `counts`, the types still to place, can follow `last` with no type
 *  twice in a row: no type more than half of what is left, rounded up, or
 *  rounded down for the type just placed. */
function separable(counts: ReadonlyMap<QuestionType, number>, last: QuestionType | null): boolean {
  let left = 0;
  for (const n of counts.values()) left += n;
  for (const [type, n] of counts) {
    if (n > (type === last ? Math.floor(left / 2) : Math.ceil(left / 2))) return false;
  }
  return true;
}

/** Spec D6. Highest p first, and no type twice in a row where an order without
 *  it exists: the highest-p unit whose type differs from the last and leaves
 *  the rest separable, else the highest-p one that differs, else the highest. */
function ordered(units: Unit[]): Unit[] {
  const left = [...units].sort((a, b) => b.p - a.p || a.indices[0] - b.indices[0]);
  const counts = new Map<QuestionType, number>();
  for (const unit of left) counts.set(unit.type, (counts.get(unit.type) ?? 0) + 1);
  const out: Unit[] = [];
  let last: QuestionType | null = null;
  while (left.length > 0) {
    const fits = (unit: Unit) => {
      if (unit.type === last) return false;
      counts.set(unit.type, counts.get(unit.type)! - 1);
      const ok = separable(counts, unit.type);
      counts.set(unit.type, counts.get(unit.type)! + 1);
      return ok;
    };
    let at = left.findIndex(fits);
    if (at < 0) at = left.findIndex((unit) => unit.type !== last);
    if (at < 0) at = 0;
    const [unit] = left.splice(at, 1);
    counts.set(unit.type, counts.get(unit.type)! - 1);
    out.push(unit);
    last = unit.type;
  }
  return out;
}

export function planCards(picks: readonly PlanPick[], input: PlanInput): SessionPlan {
  // Phase 25. A session of one word gets no speaking card: its only card's
  // "can't speak now" could pass, leaving nothing to score.
  const speaking = input.speaking && picks.length > 1;

  const used = new Map<QuestionType, number>();
  const cards = picks.map((pick) => {
    const { chosen, ...card } = cardFor(pick, used, input.listening, speaking);
    if (chosen) used.set(card.type, (used.get(card.type) ?? 0) + 1);
    return card;
  });

  // Spec D6, D10: four multiple-choice picks whose forms and meanings all
  // differ become one matching board; otherwise there is none.
  const multipleChoice = cards.flatMap((card, index) => (card.type === 'multiple_choice' ? [index] : []));
  const board = boardPicks(picks, multipleChoice);
  const onBoard = new Set(board ?? []);

  const units: Unit[] = cards.flatMap((card, index) => (onBoard.has(index) ? [] : [{ indices: [index], ...card }]));
  if (board) units.push({ indices: board, type: 'matching', p: Math.max(...board.map((index) => cards[index].p)) });

  const order: number[] = [];
  const types: QuestionType[] = [];
  let start: number | null = null;
  for (const unit of ordered(units)) {
    if (unit.type === 'matching') start = order.length;
    for (const index of unit.indices) {
      order.push(index);
      types.push(unit.type);
    }
  }
  return { order, types, board: start === null ? null : { start } };
}
