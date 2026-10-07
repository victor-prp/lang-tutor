import type { QuestionType } from '@lang-tutor/core/domain';

import { comparable } from './distractors';

/**
 * Phase 24 (spec D3, D4, D10). Which type each position of a list session
 * gets, and in which order its picks are asked. Pure and deterministic: the
 * same picks, flags and ordinal give the same plan, so an e2e test knows every
 * position's type without a seeded rng.
 */

/** One pick as the plan reads it. `tiles`: the form can be built from tiles.
 *  `speakable`: it is one to four words, so it can be said (phase 25 D3).
 *  `clozeGap`: its saved example holds the form exactly once, so it can be
 *  blanked (phase 27 D7). */
export type PlanPick = { form: string; translation: string; tiles: boolean; speakable: boolean; clozeGap: boolean };

/** `listening`: the app said its device has a voice for the target (spec D5).
 *  `speaking`: the app said it can record (phase 25 D4).
 *  `ordinal`: how many list sessions the enrollment had before this one. */
export type PlanInput = { listening: boolean; speaking: boolean; ordinal: number };

/** `order[i]` is the index into the picks asked at position `i`, `types[i]`
 *  its type. A board takes positions `start` to `start + 3`. */
export type SessionPlan = { order: number[]; types: QuestionType[]; board: { start: number } | null };

/** Each run of three climbs these tiers: recognise, pick the form, produce.
 *  A tier's first type is always eligible. Phase 25 appends read aloud, a
 *  warm-up, to the first, and say the translation, recall, to the third.
 *  Phase 27 appends meaning recall, receptive recall, to the first: the
 *  hardest recognise card, so last. Part B puts the cloze choice at index 1 of
 *  the second tier, the typed cloze at index 1 of the third, and appends the
 *  sentence translation, the hardest produce card, to the third. */
export const TIERS: readonly (readonly QuestionType[])[] = [
  ['multiple_choice', 'listen_choice', 'read_aloud', 'typed_meaning'],
  ['reverse_choice', 'cloze_choice', 'letter_tiles'],
  ['typed_translation', 'cloze_typed', 'dictation', 'say_translation', 'sentence_translation'],
];

const SPEAKING: ReadonlySet<QuestionType> = new Set(['read_aloud', 'say_translation']);

export const BOARD_SIZE = 4;
export const BOARD_MIN_PICKS = 7;
const RUN = TIERS.length;

function eligible(type: QuestionType, pick: PlanPick, input: PlanInput): boolean {
  switch (type) {
    case 'multiple_choice':
    case 'reverse_choice':
    case 'typed_translation':
    case 'typed_meaning':
      return true;
    case 'listen_choice':
    case 'dictation':
      return input.listening;
    case 'letter_tiles':
      return pick.tiles;
    case 'read_aloud':
    case 'say_translation':
      // Only reached when speaking is on: planSession removes them otherwise.
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

  // Phase 25. Speaking off, or a session of one word (whose only card "can't
  // speak now" could pass, leaving nothing to score): the speaking types leave
  // the tiers, so the rotation is phase 24's exactly.
  const speaking = input.speaking && picks.length > 1;
  const tiers = speaking ? TIERS : TIERS.map((tier) => tier.filter((type) => !SPEAKING.has(type)));

  const types: QuestionType[] = [];
  let single = 0;
  for (const index of order) {
    if (onBoard.has(index)) {
      types.push('matching');
      continue;
    }
    const tier = tiers[single % RUN];
    const run = Math.floor(single / RUN);
    types.push(typeIn(tier, (input.ordinal + run) % tier.length, picks[index], input));
    single++;
  }
  return { order, types, board: board ? { start: firstRun } : null };
}
