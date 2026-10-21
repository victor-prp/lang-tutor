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
 *  cards); absent is false. */
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
  step: boolean;
  meanings?: readonly string[];
  knownMeanings?: readonly string[];
  ladder?: boolean;
  /** Phase 68 (spec D2). A target's step-down: the pick is asked as relearnCards, see it, pick it,
   *  produce it, spread like a ladder's cards. Absent is false. */
  relearn?: boolean;
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
 *  the rest separable, else the highest-p one that differs, else the highest.
 *  `last` is the type placed just before these units, if any. */
function ordered(units: Unit[], before: QuestionType | null): { out: Unit[]; last: QuestionType | null } {
  const left = [...units].sort((a, b) => b.p - a.p || a.indices[0] - b.indices[0]);
  const counts = new Map<QuestionType, number>();
  for (const unit of left) counts.set(unit.type, (counts.get(unit.type) ?? 0) + 1);
  const out: Unit[] = [];
  let last: QuestionType | null = before;
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
  return { out, last };
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

  // Phase 55 (spec D3). A word's intro stage is one unit, so nothing is merged inside it;
  // then every ladder's first practice card, its second, its third, each stage in pick order.
  // The ladder's own speaking is the session's (input.speaking), not the one-word rule's.
  const ladders = picks.flatMap((pick, index) => (pick.ladder ? [index] : []));
  const cardsOf = ladders.map((index) => ladderCards(picks[index], input.speaking));
  const intro: Unit[] = ladders.map((index, k) => ({
    indices: cardsOf[k].intro.map(() => index),
    type: 'meet',
    types: cardsOf[k].intro,
    intro: true,
    p: 1,
    step: false,
  }));
  const practice = (stage: number): Unit[] =>
    ladders.map((index, k) => ({ indices: [index], type: cardsOf[k].practice[stage], p: 1, step: false }));
  // Phase 68 (spec D2). A step-down's see, pick and produce cards, each stage between the ladders'.
  const relearnStage = (stage: 'see' | 'pick' | 'produce'): Unit[] =>
    relearns.flatMap((index) => {
      const type = relearnOf.get(index)![stage];
      return type === null ? [] : [{ indices: [index], type, p: 1, step: false }];
    });
  const stream: Unit[] = [
    ...intro,
    ...relearnStage('see'),
    ...practice(0),
    ...relearnStage('pick'),
    ...practice(1),
    ...relearnStage('produce'),
    ...practice(2),
  ];

  // Phase 37 (spec D6): the returns after every other card, so each is at least
  // the rest of the session away from the answer that owed it. Phase 54 (spec D5,
  // as ruled): they are the last of the other cards, ordered as before, so they
  // follow every other card but can go between a ladder's cards: a session of one
  // ladder and its returns does not ask the ladder back to back. With no ladder,
  // the returns come last, as before.
  const first = ordered(units.filter((unit) => !unit.step), null);
  const returns = ordered(units.filter((unit) => unit.step), first.last);
  const others = [...first.out, ...returns.out];

  // Merged evenly with the other cards: the stream places its next unit when its
  // share of the stream placed is no more than the other cards' share. A ladder
  // unit never follows its own word while another card is left to put between
  // them.
  const merged: Unit[] = [];
  let a = 0;
  let b = 0;
  while (a < stream.length || b < others.length) {
    const L = stream.length;
    const O = others.length;
    let fromStream = b >= O || (a < L && (a + 0.5) / L <= (b + 0.5) / O);
    const last = merged[merged.length - 1];
    if (fromStream && b < O && last && last.indices.includes(stream[a].indices[0])) fromStream = false;
    merged.push(fromStream ? stream[a++] : others[b++]);
  }

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
