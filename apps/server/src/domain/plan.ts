import type { QuestionType } from '@lang-tutor/core/domain';

/**
 * Phase 24 (spec D3, D4, D10). Which type each position of a list session
 * gets, and in which order its picks are asked. Pure and deterministic: the
 * same picks, flags and ordinal give the same plan, so an e2e test knows every
 * position's type without a seeded rng.
 */

/** One pick as the plan reads it. `tiles`: the form can be built from tiles. */
export type PlanPick = { form: string; translation: string; tiles: boolean };

/** `listening`: the app said its device has a voice for the target (spec D5).
 *  `ordinal`: how many list sessions the enrollment had before this one. */
export type PlanInput = { listening: boolean; ordinal: number };

/** `order[i]` is the index into the picks asked at position `i`, `types[i]`
 *  its type. A board takes positions `start` to `start + 3`. */
export type SessionPlan = { order: number[]; types: QuestionType[]; board: { start: number } | null };

/** Each run of three climbs these tiers: recognise, pick the form, produce.
 *  A tier's first type is always eligible. Part B inserts the cloze types at
 *  index 1 of the second and third. */
export const TIERS: readonly (readonly QuestionType[])[] = [
  ['multiple_choice', 'listen_choice'],
  ['reverse_choice', 'letter_tiles'],
  ['typed_translation', 'dictation'],
];

export const BOARD_SIZE = 4;
export const BOARD_MIN_PICKS = 7;
const RUN = TIERS.length;

function eligible(type: QuestionType, pick: PlanPick, input: PlanInput): boolean {
  switch (type) {
    case 'multiple_choice':
    case 'reverse_choice':
    case 'typed_translation':
      return true;
    case 'listen_choice':
    case 'dictation':
      return input.listening;
    case 'letter_tiles':
      return pick.tiles;
    case 'matching':
      return false;
  }
}

const key = (text: string) => text.trim().toLowerCase();

/** The first four picks from `from` on whose forms and meanings all differ:
 *  two senses of one word, or two words with one meaning, would each make two
 *  pairings right. Null when four cannot be found. */
function boardPicks(picks: readonly PlanPick[], from: number): number[] | null {
  const taken: number[] = [];
  for (let i = from; i < picks.length && taken.length < BOARD_SIZE; i++) {
    const clash = taken.some(
      (j) => key(picks[j].form) === key(picks[i].form) || key(picks[j].translation) === key(picks[i].translation),
    );
    if (!clash) taken.push(i);
  }
  return taken.length === BOARD_SIZE ? taken : null;
}

/** The preferred type, or the next eligible one in the tier's order. */
function typeIn(tier: readonly QuestionType[], preferred: number, pick: PlanPick, input: PlanInput): QuestionType {
  for (let step = 0; step < tier.length; step++) {
    const type = tier[(preferred + step) % tier.length];
    if (eligible(type, pick, input)) return type;
  }
  return tier[0];
}

export function planSession(picks: readonly PlanPick[], input: PlanInput): SessionPlan {
  const firstRun = Math.min(RUN, picks.length);
  const board = picks.length >= BOARD_MIN_PICKS ? boardPicks(picks, firstRun) : null;
  const onBoard = new Set(board ?? []);
  const singles = picks.map((_, index) => index).filter((index) => !onBoard.has(index));
  const order = board ? [...singles.slice(0, firstRun), ...board, ...singles.slice(firstRun)] : singles;

  const types: QuestionType[] = [];
  let single = 0;
  for (const index of order) {
    if (onBoard.has(index)) {
      types.push('matching');
      continue;
    }
    const tier = TIERS[single % RUN];
    const run = Math.floor(single / RUN);
    types.push(typeIn(tier, (input.ordinal + run) % tier.length, picks[index], input));
    single++;
  }
  return { order, types, board: board ? { start: firstRun } : null };
}
