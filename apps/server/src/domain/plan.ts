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
 *  word choice (D5): `r` is null for a dimension with no memory yet. `step`: a
 *  same-day return (phase 37 D1), asked after every other card (D6) but a
 *  ladder's, whose cards it can go between (phase 54, spec D5).
 *  `meanings`: phase 34 (spec D3), every meaning the dictionary knows for its
 *  word and the word's homographs; none when absent. `knownMeanings`: phase 39
 *  (spec D6), the meanings already learned of a word whose new gloss this is.
 *  `ladder`: phase 54 (spec D3), a new word's first session: the pick is asked
 *  as the cards of ladderCards, whatever its rung, R, level and flags say
 *  (phase 55, spec D2: its tiles and speakable still choose the intro's
 *  cards); absent is false. `glossId`: the word the pick asks (2026-10-23, order by word, spec D1):
 *  picks with one glossId are one word, whose cards the order keeps as one sequence. */
export type PlanPick = {
  glossId: string;
  form: string;
  translation: string;
  tiles: boolean;
  speakable: boolean;
  clozeGap: boolean;
  dimension: Dimension;
  rung: 1 | 2;
  level: number;
  r: number | null;
  step: boolean;
  meanings?: readonly string[];
  knownMeanings?: readonly string[];
  ladder?: boolean;
  /** Phase 68 (spec D2, final review). A target's step-down: the pick is asked as relearnCards, see
   *  it, pick it, produce it, spread like a ladder's cards. Its see and pick cards are intro cards,
   *  for encoding, not evidence (phase 55); so is its produce card for `practice`, while `counts`
   *  makes it the card the pick would have been. Absent: none. */
  relearn?: 'counts' | 'practice';
};

/** `listening`: the app said its device has a voice for the target (phase 24 D5).
 *  `speaking`: the app said it can record (phase 25 D4). `target`: phase 57 (spec D7,
 *  ruling T3-l), a target path's session, whose picks each serve owed work: no type is held
 *  to MAX_PER_TYPE and a session of one word may still speak, so no pick falls back to a
 *  card that serves none of it. Absent is false. */
export type PlanInput = {
  listening: boolean;
  speaking: boolean;
  target?: boolean;
  /** Phase 68 (spec D5, ruling). A target session none of whose cards can raise the card today:
   *  it gets a matching board. Absent is false. */
  board?: boolean;
};

/** `order[i]` is the index into the picks asked at position `i`, `types[i]`
 *  its type. A board takes positions `start` to `start + 3`. Phase 55 (spec D2,
 *  as ruled): `intro[i]`, whether the card is one of a ladder's intro stage (the
 *  meet card, the read aloud, the card that writes the word), which is for
 *  encoding, not evidence: it counts in the score, and writes no memory, no
 *  progress and opens no return. */
export type SessionPlan = { order: number[]; types: QuestionType[]; intro: boolean[]; board: { start: number } | null };

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

/** Phase 55 (spec D2). A ladder's practice cards, in the order its first session asks
 *  them: the graded part of a ladder (its intro stage grades nothing). Always eligible.
 *  Phase 65 (ruling T9-a): today's budget plays a ladder as these, answered right. */
export const LADDER_PRACTICE: readonly QuestionType[] = ['multiple_choice', 'reverse_choice', 'typed_translation'];

/** Phase 55 (spec D2). A ladder's cards: the intro stage, then the three practice
 *  cards a new word is asked in its first session, in this order. The intro is
 *  the meet card; the read aloud, when the session can speak and the form can be
 *  said; and the card that has the learner write the word, letter tiles or, when
 *  the form takes none, typed. `speaking` is the session's, not the plan's
 *  one-word rule: a session of one ladder still says its word. The practice
 *  cards are LADDER_PRACTICE. */
export function ladderCards(
  pick: Pick<PlanPick, 'tiles' | 'speakable'>,
  speaking: boolean,
): { intro: QuestionType[]; practice: QuestionType[] } {
  return {
    intro: ['meet', ...(speaking && pick.speakable ? (['read_aloud'] as const) : []), pick.tiles ? 'letter_tiles' : 'typed_translation'],
    practice: [...LADDER_PRACTICE],
  };
}

/** Phase 68 (spec D2). The pick cards of a step-down, in the direction of the miss (from the
 *  learner's language), in the order a tie falls to. */
const PICK_CARDS: readonly QuestionType[] = ['reverse_choice', 'cloze_choice', 'letter_tiles'];

/**
 * Phase 68 (spec D2). A step-down's cards: see it, a read aloud, when the session can speak and the
 * form can be said; pick it, the least used in the session of reverse choice, choose-the-gap (its
 * sentence has a gap) and letter tiles (its form takes them), ties in that order, or for spelling
 * letter tiles, else reverse choice; produce it, its skill's own card at its rung, as cardFor
 * chooses one on a target. `used` is the session's type count so far.
 */
export function relearnCards(
  pick: PlanPick,
  input: { listening: boolean; speaking: boolean },
  used: ReadonlyMap<QuestionType, number>,
): { see: QuestionType | null; pick: QuestionType; produce: QuestionType } {
  const see = input.speaking && pick.speakable ? 'read_aloud' : null;
  const fits = (type: QuestionType) => eligible(type, pick, input.listening, input.speaking, true);
  const chosen =
    pick.dimension === 'spelling'
      ? fits('letter_tiles')
        ? 'letter_tiles'
        : 'reverse_choice'
      : PICK_CARDS.filter(fits).reduce((best, type) => ((used.get(type) ?? 0) < (used.get(best) ?? 0) ? type : best));
  const produce = cardFor({ ...pick, rung: pick.dimension === 'spelling' ? 1 : 2 }, used, input.listening, input.speaking, true).type;
  return { see, pick: chosen, produce };
}

/** Spec D6: no type is chosen more than this many times in one session. A new
 *  word's multiple choice, and the last resort's, are not chosen and do not
 *  count: four new words would otherwise send every recognised word to recall,
 *  though those four are about to become a board. A ladder's cards (phase 54,
 *  spec D3) are not chosen either, and do not count. */
export const MAX_PER_TYPE = 4;

export const BOARD_SIZE = 4;
/** Ruling 18, as phase 24: a smaller session has no board, which would
 *  swallow it into one card. */
export const BOARD_MIN_PICKS = 7;

/** The cards with four options to pick from: a guess is right one time in four. */
const FOUR_OPTION: ReadonlySet<QuestionType> = new Set(['multiple_choice', 'new_meaning', 'reverse_choice', 'cloze_choice', 'listen_choice']);

const SPEAKING: ReadonlySet<QuestionType> = new Set(['read_aloud', 'say_translation']);

/** `speaking` is the session's: on, and more than one word (phase 25). `target`: a target path's
 *  session (phase 68, spec D2, D4), whose read aloud is the word seen and said at any level. */
function eligible(type: QuestionType, pick: PlanPick, listening: boolean, speaking: boolean, target = false): boolean {
  if (SPEAKING.has(type) && !speaking) return false;
  switch (type) {
    case 'multiple_choice':
    case 'new_meaning':
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
      return pick.speakable && (target || pick.level < READ_ALOUD_MAX_LEVEL);
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
    case 'meet':
      // Phase 54 (spec D3, D5). A ladder's first card, which planCards places from a pick's ladder flag: never a rung's choice.
      return false;
  }
}

// The same comparison the distractors use: points, stress, a full stop and case
// do not make two words different.
const key = comparable;

/** Phase 34 (spec D3). Two board words overlap when either's meaning on the
 *  board is one the dictionary knows for the other: then both pairings of that
 *  meaning are right (`main` on מרכזי, which `mainstream` reaches too). */
const overlaps = (a: PlanPick, b: PlanPick): boolean =>
  key(a.translation) === key(b.translation) ||
  (b.meanings ?? []).some((meaning) => key(meaning) === key(a.translation)) ||
  (a.meanings ?? []).some((meaning) => key(meaning) === key(b.translation));

/** The first four of `candidates` (indices into `picks`) whose forms and
 *  meanings all differ: two senses of one word, or two words with one meaning,
 *  would each make two pairings right. Null when four cannot be found. */
function boardPicks(picks: readonly PlanPick[], candidates: readonly number[]): number[] | null {
  const taken: number[] = [];
  for (const i of candidates) {
    if (taken.length === BOARD_SIZE) break;
    const clash = taken.some((j) => key(picks[j].form) === key(picks[i].form) || overlaps(picks[j], picks[i]));
    if (!clash) taken.push(i);
  }
  return taken.length === BOARD_SIZE ? taken : null;
}

type Card = { type: QuestionType; p: number };
/** `chosen`: picked from a rung, so it counts toward MAX_PER_TYPE. */
type Choice = Card & { chosen: boolean };

/** Spec D6. The eligible type of the rung whose chance is nearest CARD_TARGET;
 *  a tie goes to the type used least, then to the table's order. Null when the
 *  rung has no eligible type left. A return (phase 37 D6) is not held to
 *  MAX_PER_TYPE: written receptive has one recall type, and a word met today
 *  would otherwise be settled by a multiple choice, never recalled. Nor is a
 *  target path's pick (`free`, phase 57 ruling T3-l). */
function bestIn(
  rung: 1 | 2,
  pick: PlanPick,
  used: ReadonlyMap<QuestionType, number>,
  listening: boolean,
  speaking: boolean,
  free: boolean,
): Card | null {
  let best: (Card & { distance: number; uses: number }) | null = null;
  for (const type of RUNGS[pick.dimension][rung - 1]) {
    const uses = used.get(type) ?? 0;
    if ((uses >= MAX_PER_TYPE && !pick.step && !free) || !eligible(type, pick, listening, speaking, free)) continue;
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
function cardFor(pick: PlanPick, used: ReadonlyMap<QuestionType, number>, listening: boolean, speaking: boolean, free: boolean): Choice {
  // Phase 39 (spec D6): a new gloss of a known word is a new_meaning, not chosen
  // from a rung: it does not count toward MAX_PER_TYPE, nor go on a board.
  if (pick.knownMeanings?.length) return { type: 'new_meaning', p: expectedSuccess(pick.r, true, 1), chosen: false };
  const multipleChoice = { type: 'multiple_choice' as const, p: expectedSuccess(pick.r, true, 1), chosen: false };
  if (pick.dimension === 'written_receptive' && pick.r === null) return multipleChoice;
  const other = pick.rung === 1 ? 2 : 1;
  const card = bestIn(pick.rung, pick, used, listening, speaking, free) ?? bestIn(other, pick, used, listening, speaking, free);
  return card ? { ...card, chosen: true } : multipleChoice;
}

/** What the order places: one pick, or the board's four together, or (phase 55,
 *  spec D3) a ladder's intro stage, whose cards are `types`, one per index, and
 *  (spec D2, as ruled) `intro`. */
type Unit = { indices: number[]; type: QuestionType; types?: QuestionType[]; intro?: true; p: number; step: boolean };

/** Whether `counts`, what is still to place by type or by word, can follow `last`
 *  with no key twice in a row: no key more than half of what is left, rounded up,
 *  or rounded down for the key just placed. */
function separable<K>(counts: ReadonlyMap<K, number>, last: K | null): boolean {
  let left = 0;
  for (const n of counts.values()) left += n;
  for (const [key, n] of counts) {
    if (n > (key === last ? Math.floor(left / 2) : Math.ceil(left / 2))) return false;
  }
  return true;
}

/** `counts` with one fewer of `key`. */
const lessOne = <K>(counts: ReadonlyMap<K, number>, key: K): Map<K, number> => new Map(counts).set(key, (counts.get(key) ?? 0) - 1);

/** The board's sequence, which no gloss id can name. */
const BOARD = '\u0000board';

/**
 * Order by word (2026-10-23, spec D3, D4). `sequences` holds each word's units in the order the word
 * asks them. One pass: at each position every sequence offers its next unit, and the one placed is
 * decided by these in turn, the first that tells two apart deciding: not of the word just placed;
 * every word can still be kept apart; not the type just placed; every type can still be kept apart;
 * the sequence furthest behind an even spread over the session; the higher p; the lower pick index.
 * Phase 37 D6: a return is offered once every unit that is neither a return nor of a `streamed` word
 * (a ladder's or a step-down's) is placed, and while it waits the type test counts only what can go
 * before it (D4).
 */
function byWord(sequences: ReadonlyMap<string, readonly Unit[]>, wordsOf: (unit: Unit) => ReadonlySet<string>, streamed: ReadonlySet<string>): Unit[] {
  const total = [...sequences.values()].reduce((sum, sequence) => sum + sequence.length, 0);
  const placed = new Map<string, number>();
  const rest = (key: string) => sequences.get(key)!.slice(placed.get(key) ?? 0);
  const merged: Unit[] = [];
  while (merged.length < total) {
    const t = merged.length;
    const last = merged[t - 1];
    const lastWords = last ? wordsOf(last) : new Set<string>();
    const lastType = last ? (last.types?.[last.types.length - 1] ?? last.type) : null;
    const waiting = [...sequences.keys()].some((key) => !streamed.has(key) && rest(key).some((unit) => !unit.step));
    const words = new Map<string, number>();
    const types = new Map<QuestionType, number>();
    for (const key of sequences.keys()) {
      const units = rest(key);
      if (units.length > 0) words.set(key, units.length);
      for (const unit of units) if (!waiting || !unit.step) types.set(unit.type, (types.get(unit.type) ?? 0) + 1);
    }
    const heads = [...sequences].flatMap(([key, sequence]) => {
      const k = placed.get(key) ?? 0;
      return k < sequence.length ? [{ key, unit: sequence[k], k, n: sequence.length }] : [];
    });
    const open = heads.filter(({ unit }) => !waiting || !unit.step);
    const scored = (open.length > 0 ? open : heads).map((head) => {
      const { key, unit, k, n } = head;
      const score = [
        [...wordsOf(unit)].some((word) => lastWords.has(word)) ? 1 : 0,
        separable(lessOne(words, key), key) ? 0 : 1,
        (unit.types?.[0] ?? unit.type) === lastType ? 1 : 0,
        separable(lessOne(types, unit.type), unit.type) ? 0 : 1,
        // Behind an even spread: the share of the word placed against the share of the session.
        (k + 0.5) / n - (t + 0.5) / total,
        -unit.p,
        unit.indices[0],
      ];
      return { head, score };
    });
    const first = (a: number[], b: number[]) => a.findIndex((value, i) => value !== b[i]);
    const best = scored.reduce((winner, next) => {
      const i = first(next.score, winner.score);
      return i >= 0 && next.score[i] < winner.score[i] ? next : winner;
    });
    merged.push(best.head.unit);
    placed.set(best.head.key, best.head.k + 1);
  }
  return merged;
}

export function planCards(picks: readonly PlanPick[], input: PlanInput): SessionPlan {
  // Phase 25. A session of one word gets no speaking card: its only card's
  // "can't speak now" could pass, leaving nothing to score. Phase 57 (ruling T3-l): a
  // target's may, since its one pick can be the target's only owed work.
  const target = input.target ?? false;
  const speaking = input.speaking && (picks.length > 1 || target);

  // Phase 54 (spec D3). A ladder pick has no card of its own: its cards are
  // fixed, and it touches no type's count.
  const used = new Map<QuestionType, number>();
  const cards = picks.map((pick): Card | null => {
    if (pick.ladder || pick.relearn) return null;
    const { chosen, ...card } = cardFor(pick, used, input.listening, speaking, target);
    if (chosen) used.set(card.type, (used.get(card.type) ?? 0) + 1);
    return card;
  });
  // Phase 68 (spec D2). Each step-down's cards, after the other picks', so its pick card is the one
  // the session used least.
  const relearns = picks.flatMap((pick, index) => (pick.relearn ? [index] : []));
  const relearnOf = new Map(
    relearns.map((index) => {
      const cardsOf = relearnCards(picks[index], { listening: input.listening, speaking: input.speaking }, used);
      for (const type of [cardsOf.pick, cardsOf.produce]) used.set(type, (used.get(type) ?? 0) + 1);
      return [index, cardsOf] as const;
    }),
  );

  // Spec D6, D10: in a session of at least BOARD_MIN_PICKS, four
  // multiple-choice picks whose forms and meanings all differ become one
  // matching board; otherwise there is none. A return is never on it: it
  // follows every card that is not a return (phase 37 D6), though since phase 54
  // (spec D5, as ruled) a ladder's cards can go between the returns. A ladder's
  // multiple choice is never on it (phase 54, spec D3).
  const multipleChoice = cards.flatMap((card, index) => (card?.type === 'multiple_choice' && !picks[index].step ? [index] : []));
  // Phase 68 (spec D5, ruling). A target's board is an extra card over four met words its session
  // asks anyway, the step-down words first, in a session the picker says cannot raise the card; a
  // ladder's word and a new meaning are never on it.
  const met = picks.flatMap((pick, index) => (!pick.ladder && !pick.knownMeanings?.length ? [index] : []));
  const stepFirst = [...met.filter((index) => picks[index].relearn), ...met.filter((index) => !picks[index].relearn)];
  const board = target
    ? input.board
      ? boardPicks(picks, stepFirst)
      : null
    : picks.length >= BOARD_MIN_PICKS
      ? boardPicks(picks, multipleChoice)
      : null;
  const onBoard = new Set(target ? [] : (board ?? []));

  const units: Unit[] = cards.flatMap((card, index) =>
    card === null || onBoard.has(index) ? [] : [{ indices: [index], ...card, step: picks[index].step }],
  );
  if (board) units.push({ indices: board, type: 'matching', p: Math.max(...board.map((index) => cards[index]?.p ?? 1)), step: false });

  // Order by word (2026-10-23, spec D2). Each word's units are one sequence, in the order the word
  // asks them: its ladder's intro stage (one unit, phase 55 D3) and practice cards, its step-down's
  // see, pick and produce (phase 68 D2), then its other cards in pick order, so the 67b say card is a
  // new word's last. The board is a sequence of its own. The ladder's own speaking is the session's
  // (input.speaking), not the one-word rule's.
  const ladders = picks.flatMap((pick, index) => (pick.ladder ? [index] : []));
  const sequences = new Map<string, Unit[]>();
  const sequenceOf = (key: string): Unit[] => {
    const sequence = sequences.get(key) ?? [];
    sequences.set(key, sequence);
    return sequence;
  };
  for (const index of ladders) {
    const { intro, practice } = ladderCards(picks[index], input.speaking);
    const sequence = sequenceOf(picks[index].glossId);
    sequence.push({ indices: intro.map(() => index), type: 'meet', types: intro, intro: true, p: 1, step: false });
    for (const type of practice) sequence.push({ indices: [index], type, p: 1, step: false });
  }
  for (const index of relearns) {
    const sequence = sequenceOf(picks[index].glossId);
    for (const stage of ['see', 'pick', 'produce'] as const) {
      const type = relearnOf.get(index)![stage];
      if (type === null) continue;
      const evidence = stage === 'produce' && picks[index].relearn === 'counts';
      sequence.push({ indices: [index], type, ...(evidence ? {} : { intro: true as const }), p: 1, step: false });
    }
  }
  for (const unit of units) sequenceOf(unit.type === 'matching' ? BOARD : picks[unit.indices[0]].glossId).push(unit);

  // Phase 37 (spec D6): the returns after every other card but a ladder's or a step-down's word's,
  // so each is at least the rest of the session away from the answer that owed it.
  const streamed = new Set([...ladders, ...relearns].map((index) => picks[index].glossId));
  const merged = byWord(sequences, (unit) => new Set(unit.indices.map((index) => picks[index].glossId)), streamed);

  const order: number[] = [];
  const types: QuestionType[] = [];
  const inIntro: boolean[] = [];
  let start: number | null = null;
  for (const unit of merged) {
    if (unit.type === 'matching') start = order.length;
    unit.indices.forEach((index, k) => {
      order.push(index);
      types.push(unit.types?.[k] ?? unit.type);
      inIntro.push(unit.intro ?? false);
    });
  }
  return { order, types, intro: inIntro, board: start === null ? null : { start } };
}
