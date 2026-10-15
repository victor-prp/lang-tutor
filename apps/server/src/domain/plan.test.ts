import { describe, expect, it } from '@jest/globals';
import type { Dimension, QuestionType } from '@lang-tutor/core/domain';

import { expectedSuccess } from './choose';
import { CARD_TARGET } from './chooseConstants';
import { BOARD_MIN_PICKS, MAX_PER_TYPE, RUNGS, ladderCards, planCards, type PlanInput, type PlanPick } from './plan';

const WR: Dimension = 'written_receptive';
const WP: Dimension = 'written_productive';
const SP: Dimension = 'spelling';
const SR: Dimension = 'spoken_receptive';
const SK: Dimension = 'spoken_productive';

/** A new word unless told otherwise: written receptive, rung 1, level 1, no R. */
const pick = (n: number, over: Partial<PlanPick> = {}): PlanPick => ({
  form: `word${n}`,
  translation: `מילה${n}`,
  tiles: true,
  speakable: true,
  clozeGap: true,
  dimension: WR,
  rung: 1,
  level: 1,
  r: null,
  step: false,
  ...over,
});

/** A known word at rung 1: R 0.5, level 1. At rung 2: R 0.9, level 3. */
const at = (n: number, dimension: Dimension, rung: 1 | 2, over: Partial<PlanPick> = {}): PlanPick =>
  pick(n, rung === 1 ? { dimension, rung, level: 1, r: 0.5, ...over } : { dimension, rung, level: 3, r: 0.9, ...over });

const ALL: PlanInput = { listening: true, speaking: true };
const NONE: PlanInput = { listening: false, speaking: false };

/** The type each pick got, by pick index (not position). */
function typesByPick(picks: PlanPick[], input: PlanInput = ALL): QuestionType[] {
  const plan = planCards(picks, input);
  const out: QuestionType[] = [];
  plan.order.forEach((index, position) => (out[index] = plan.types[position]));
  return out;
}

/** The first pick's type, in a session with one other word (a session of one
 *  word gets no speaking card). */
const typeOf = (p: PlanPick, input: PlanInput = ALL) => typesByPick([p, pick(99)], input)[0];

const count = (types: readonly QuestionType[], type: QuestionType) => types.filter((t) => t === type).length;

describe('planCards: the rungs (spec D6)', () => {
  it('has the table of the spec', () => {
    expect(RUNGS).toEqual({
      written_receptive: [['multiple_choice'], ['typed_meaning']],
      written_productive: [
        ['reverse_choice', 'cloze_choice', 'letter_tiles'],
        ['typed_translation', 'cloze_typed', 'sentence_translation'],
      ],
      spelling: [['dictation'], ['typed_translation', 'cloze_typed']],
      spoken_receptive: [['listen_choice'], ['dictation']],
      spoken_productive: [['read_aloud'], ['say_translation']],
    });
  });

  it.each([
    [WR, 1, 'multiple_choice'],
    [WR, 2, 'typed_meaning'],
    [WP, 1, 'reverse_choice'],
    [WP, 2, 'typed_translation'],
    [SP, 1, 'dictation'],
    [SP, 2, 'typed_translation'],
    [SR, 1, 'listen_choice'],
    [SR, 2, 'dictation'],
    [SK, 1, 'read_aloud'],
    [SK, 2, 'say_translation'],
  ] as [Dimension, 1 | 2, QuestionType][])('asks %s at rung %d with %s', (dimension, rung, type) => {
    expect(typeOf(at(0, dimension, rung))).toBe(type);
  });
});

describe('planCards: aiming at CARD_TARGET (spec D6)', () => {
  it('takes the type whose p = g + (1 − g)·R^e is nearest the target', () => {
    // Rung 1, R 0.81: tiles p = 0.9 (0.05 off), a four-option card 0.925 (0.075 off).
    expect(Math.abs(expectedSuccess(0.81, false, 1) - CARD_TARGET)).toBeLessThan(
      Math.abs(expectedSuccess(0.81, true, 1) - CARD_TARGET),
    );
    expect(typeOf(at(0, WP, 1, { r: 0.81 }))).toBe('letter_tiles');
    // R 0.5: tiles 0.707 (0.143 off), four-option 0.780 (0.070 off).
    expect(typeOf(at(0, WP, 1, { r: 0.5 }))).toBe('reverse_choice');
  });

  it('takes the next nearest when the nearest is not eligible', () => {
    expect(typeOf(at(0, WP, 1, { r: 0.81, tiles: false }))).toBe('reverse_choice');
    expect(typeOf(at(0, WP, 1, { r: 0.5, clozeGap: false }))).toBe('reverse_choice');
  });

  it('breaks a tie by the type used least so far, then by the table', () => {
    // reverse_choice and cloze_choice are both four-option: always tied.
    expect(typesByPick([at(0, WP, 1), at(1, WP, 1), at(2, WP, 1)])).toEqual([
      'reverse_choice',
      'cloze_choice',
      'reverse_choice',
    ]);
    // The three typed WP cards are all g = 0 at rung 2.
    expect(typesByPick([at(0, WP, 2), at(1, WP, 2), at(2, WP, 2), at(3, WP, 2)])).toEqual([
      'typed_translation',
      'cloze_typed',
      'sentence_translation',
      'typed_translation',
    ]);
  });

  it('uses no type more than four times, moving on to the next nearest', () => {
    expect(MAX_PER_TYPE).toBe(4);
    // No gap: reverse_choice is the only four-option WP card, and nearest at R 0.5.
    const types = typesByPick(Array.from({ length: 6 }, (_, i) => at(i, WP, 1, { clozeGap: false })));
    expect(count(types, 'reverse_choice')).toBe(4);
    expect(count(types, 'letter_tiles')).toBe(2);
    // A rung whose every type is spent falls to the other rung.
    const sr = typesByPick(Array.from({ length: 5 }, (_, i) => at(i, SR, 1)));
    expect(count(sr, 'listen_choice')).toBe(4);
    expect(count(sr, 'dictation')).toBe(1);
  });
});

// Phase 39 (spec D6).
describe('planCards: new_meaning', () => {
  const meaning = (n: number, over: Partial<PlanPick> = {}) => at(n, WR, 1, { knownMeanings: ['להרים'], ...over });

  it('turns a pick with known meanings into new_meaning, whatever its dimension or rung', () => {
    expect(typeOf(meaning(0))).toBe('new_meaning');
    expect(typeOf(pick(0, { knownMeanings: ['להרים'] }))).toBe('new_meaning');
    expect(typeOf(at(0, WP, 2, { knownMeanings: ['להרים'] }))).toBe('new_meaning');
    expect(typeOf(pick(0, { knownMeanings: [] }))).toBe('multiple_choice');
  });

  it('does not count toward MAX_PER_TYPE', () => {
    const list = [...Array.from({ length: 5 }, (_, i) => meaning(i)), ...Array.from({ length: 4 }, (_, i) => at(10 + i, WR, 1, { form: 'same' }))];
    const types = typesByPick(list);
    expect(types.slice(0, 5)).toEqual(Array(5).fill('new_meaning'));
    expect(types.slice(5)).toEqual(Array(4).fill('multiple_choice'));
  });

  it('is never on a board, in a ten-pick session', () => {
    const list = [meaning(0), meaning(1), pick(2), pick(3), pick(4), pick(5), pick(6), meaning(7), meaning(8), pick(9)];
    const plan = planCards(list, ALL);
    expect(plan.board).not.toBeNull();
    const start = plan.board!.start;
    const onBoard = plan.order.slice(start, start + 4);
    expect(onBoard.every((index) => list[index].knownMeanings === undefined)).toBe(true);
    expect(count(plan.types, 'new_meaning')).toBe(4);
    expect(count(plan.types, 'matching')).toBe(4);
  });
});

describe('planCards: fallbacks (spec D6)', () => {
  it('takes the other rung when the chosen one has no eligible type', () => {
    // Dictation needs listening.
    expect(typeOf(at(0, SP, 1), { listening: false, speaking: true })).toBe('typed_translation');
    // Read aloud is spent once SK reaches level 2: say the translation.
    expect(typeOf(at(0, SK, 1, { level: 2 }))).toBe('say_translation');
    // Multiple choice spent (forms that clash, so no board): typed meaning.
    const five = typesByPick(Array.from({ length: 5 }, (_, i) => at(i, WR, 1, { form: 'same' })));
    expect(five).toEqual([...Array(4).fill('multiple_choice'), 'typed_meaning']);
  });

  it('takes multiple choice when neither rung has one', () => {
    expect(typeOf(at(0, SR, 1), NONE)).toBe('multiple_choice');
    expect(typeOf(at(0, SR, 2), NONE)).toBe('multiple_choice');
    expect(typeOf(at(0, SK, 2), { listening: true, speaking: false })).toBe('multiple_choice');
    expect(typeOf(at(0, SK, 1, { speakable: false }))).toBe('multiple_choice');
  });

  it('gives a one-word session no speaking card', () => {
    expect(planCards([at(0, SK, 1)], ALL).types).toEqual(['multiple_choice']);
    expect(planCards([at(0, SK, 2)], ALL).types).toEqual(['multiple_choice']);
  });

  it('keeps the eligibility rules: tiles, a cloze gap, a speakable form', () => {
    expect(typeOf(at(0, WP, 1, { r: 0.81, tiles: false, clozeGap: false }))).toBe('reverse_choice');
    const unspeakable = typesByPick(Array.from({ length: 6 }, (_, i) => at(i, WP, 2, { speakable: false })));
    expect(unspeakable).not.toContain('cloze_typed');
    expect(unspeakable).not.toContain('sentence_translation');
    const noGap = typesByPick(Array.from({ length: 6 }, (_, i) => at(i, WP, 1, { clozeGap: false })));
    expect(noGap).not.toContain('cloze_choice');
  });
});

describe('planCards: a new word (spec D6)', () => {
  it('takes multiple choice', () => {
    expect(typeOf(pick(0))).toBe('multiple_choice');
  });

  it('takes multiple choice even past the four-per-type limit', () => {
    // Six new words whose forms clash, so no board takes four of them.
    const six = Array.from({ length: 6 }, (_, i) => pick(i, { form: 'same' }));
    expect(planCards(six, ALL).types).toEqual(Array(6).fill('multiple_choice'));
  });

  it('does not count toward the limit, so recognised words still get multiple choice', () => {
    // Four new words (a board) and four recognised ones whose forms clash with each other.
    const list = [pick(0), pick(1), pick(2), pick(3), ...Array.from({ length: 4 }, (_, i) => at(4 + i, WR, 1, { form: 'same' }))];
    const types = typesByPick(list);
    expect(types.slice(4)).toEqual(Array(4).fill('multiple_choice'));
    expect(count(types, 'matching')).toBe(4);
  });
});

describe('planCards: read aloud (spec D6)', () => {
  it('reads aloud only while SK is unintroduced or below level 2, so once', () => {
    expect(typeOf(pick(0, { dimension: SK, rung: 1, level: 1, r: null }))).toBe('read_aloud');
    expect(typeOf(pick(0, { dimension: SK, rung: 1, level: 1, r: 0.5 }))).toBe('read_aloud');
    // A read aloud said right raises SK to 2 and writes no memory: next time, say it.
    expect(typeOf(pick(0, { dimension: SK, rung: 1, level: 2, r: null }))).toBe('say_translation');
    expect(typeOf(pick(0, { dimension: SK, rung: 1, level: 2, r: 0.5 }))).toBe('say_translation');
  });

  it('never reads aloud with speaking off', () => {
    expect(typeOf(pick(0, { dimension: SK, rung: 1 }), { listening: true, speaking: false })).toBe('multiple_choice');
  });
});

describe('planCards: the board (spec D6, D10)', () => {
  it('makes four multiple-choice picks with distinct forms and meanings one board, from seven picks', () => {
    expect(BOARD_MIN_PICKS).toBe(7);
    // Four new words (p 1) and three typed ones (p 0.9): the board first.
    const list = [pick(0), pick(1), pick(2), pick(3), at(4, WP, 2), at(5, WP, 2), at(6, WP, 2)];
    const plan = planCards(list, ALL);
    expect(plan.board).toEqual({ start: 0 });
    expect(plan.types.slice(0, 4)).toEqual(['matching', 'matching', 'matching', 'matching']);
    expect(plan.order.slice(0, 4)).toEqual([0, 1, 2, 3]);
  });

  // Ruling 18: a board in a small session would swallow it into one card.
  it('has no board under seven picks, even with four distinct multiple-choice picks', () => {
    const four = planCards([pick(0), pick(1), pick(2), pick(3)], ALL);
    expect(four.board).toBeNull();
    expect(four.types).toEqual(Array(4).fill('multiple_choice'));
    const six = planCards([pick(0), pick(1), pick(2), pick(3), at(4, WP, 2), at(5, WP, 2)], ALL);
    expect(six.board).toBeNull();
    expect(six.types).not.toContain('matching');
    expect(count(six.types, 'multiple_choice')).toBe(4);
  });

  it('has no board with fewer than four multiple-choice picks', () => {
    const plan = planCards([pick(0), pick(1), pick(2), at(3, WP, 1), at(4, WP, 2), at(5, WP, 1), at(6, WP, 2)], ALL);
    expect(plan.board).toBeNull();
    expect(plan.types).not.toContain('matching');
    expect(count(plan.types, 'multiple_choice')).toBe(3);
  });

  it('takes only multiple-choice picks onto the board, and keeps its four together', () => {
    const list = [at(0, WP, 1), pick(1), at(2, WP, 2), pick(3), pick(4), at(5, SR, 1), pick(6), pick(7)];
    const plan = planCards(list, ALL);
    expect(plan.board).not.toBeNull();
    const start = plan.board!.start;
    expect(plan.types.slice(start, start + 4)).toEqual(['matching', 'matching', 'matching', 'matching']);
    expect(plan.order.slice(start, start + 4)).toEqual([1, 3, 4, 6]);
    expect(count(plan.types, 'matching')).toBe(4);
    // The fifth new word stays a multiple choice.
    expect(typesByPick(list, ALL)[7]).toBe('multiple_choice');
  });

  // Review Focus 2 (phase 24).
  it('never puts two senses of one word, or two words with one meaning, on a board', () => {
    const list: PlanPick[] = [
      pick(0, { form: 'lock', translation: 'מנעול' }),
      pick(1, { form: 'Lock', translation: 'טירה' }),
      pick(2, { form: 'big', translation: 'גדול' }),
      pick(3, { form: 'large', translation: 'גָּדוֹל.' }),
      pick(4),
      pick(5),
      at(6, WP, 2),
    ];
    const plan = planCards(list, ALL);
    const start = plan.board!.start;
    expect(plan.order.slice(start, start + 4)).toEqual([0, 2, 4, 5]);
  });

  // Phase 34 (spec D3). 282213b7: main sat on board f8ccaf3d as מרכזי beside
  // mainstream, which the dictionary also knows as מרכזי. Either pairing was right.
  it('category A (282213b7): never puts main and mainstream on one board when mainstream is also מרכזי', () => {
    const main = pick(0, { form: 'main', translation: 'מרכזי', meanings: ['מרכזי', 'ראשי', 'ים פתוח'] });
    const mainstream = pick(1, { form: 'mainstream', translation: 'מיינסטרימי', meanings: ['מיינסטרימי', 'מרכזי'] });
    const rest = [2, 3, 4, 5, 6].map((n) => pick(n));
    const boardOf = (list: PlanPick[]) => {
      const plan = planCards(list, ALL);
      const start = plan.board!.start;
      return plan.order.slice(start, start + 4);
    };
    // Seven new words, each a multiple choice: the board is main and the next
    // three; mainstream stays a multiple choice of its own.
    expect(boardOf([main, mainstream, ...rest])).toEqual([0, 2, 3, 4]);
    // Either way round: the clash is found from the later word's meanings too.
    expect(boardOf([mainstream, main, ...rest])).toEqual([0, 2, 3, 4]);
    // Without what the dictionary knows, the two share the board, as on lane 0.
    expect(boardOf([main, mainstream, ...rest].map(({ meanings: _, ...other }) => other))).toEqual([0, 1, 2, 3]);
  });

  it('has no board when four distinct words cannot be found', () => {
    const list = Array.from({ length: 8 }, (_, i) => pick(i, { form: i < 3 ? `w${i}` : 'w0' }));
    const plan = planCards(list, ALL);
    expect(plan.board).toBeNull();
    expect(plan.types).not.toContain('matching');
  });
});

describe('planCards: the order (spec D6)', () => {
  it('puts the highest p first', () => {
    // p: SR rung 1 at R 0.25 = 0.625; WP rung 2 at R 0.9 = 0.9; WR rung 2 at R 0.8, level 3 = 0.8.
    const list = [at(0, SR, 1, { r: 0.25 }), at(1, WP, 2), at(2, WR, 2, { r: 0.8 })];
    const plan = planCards(list, ALL);
    expect(plan.order).toEqual([1, 2, 0]);
    expect(plan.types).toEqual(['typed_translation', 'typed_meaning', 'listen_choice']);
  });

  it('avoids one type twice in a row where it can', () => {
    // Two new words (p 1) and a typed meaning (p 0.95): the typed meaning goes between them.
    const plan = planCards([pick(0), pick(1), at(2, WR, 2, { r: 0.95 })], ALL);
    expect(plan.types).toEqual(['multiple_choice', 'typed_meaning', 'multiple_choice']);
    expect(plan.order).toEqual([0, 2, 1]);
  });

  it('repeats a type only when nothing else is left', () => {
    const plan = planCards([pick(0, { form: 'a' }), pick(1, { form: 'a' }), pick(2, { form: 'a' })], ALL);
    expect(plan.types).toEqual(['multiple_choice', 'multiple_choice', 'multiple_choice']);
  });

  it('is deterministic, and never gives two cards in a row one type when another order would not', () => {
    const dimensions = [WR, WP, SP, SR, SK];
    for (let size = 2; size <= 10; size++) {
      for (const input of [ALL, NONE, { listening: true, speaking: false }]) {
        const list = Array.from({ length: size }, (_, i) =>
          i % 3 === 0 ? pick(i) : at(i, dimensions[i % 5], ((i % 2) + 1) as 1 | 2, { r: 0.4 + (i % 4) * 0.15 }),
        );
        const plan = planCards(list, input);
        expect(planCards(list, input)).toEqual(plan);
        expect([...plan.order].sort((a, b) => a - b)).toEqual(list.map((_, i) => i));
        // A board is one card: keep its first word only.
        const cards = plan.types.filter((_, i) => !(plan.board && i > plan.board.start && i < plan.board.start + 4));
        const most = Math.max(...cards.map((type) => count(cards, type)));
        // Repeats are forced only when one type is more than half the cards.
        if (most <= Math.ceil(cards.length / 2)) {
          for (let i = 1; i < cards.length; i++) expect(cards[i]).not.toBe(cards[i - 1]);
        }
      }
    }
  });
});

describe('planCards: same-day returns (phase 37 D6)', () => {
  /** A return owed today: recall, R 1 on the day it opened. */
  const back = (n: number, dimension: Dimension, over: Partial<PlanPick> = {}): PlanPick =>
    pick(n, { dimension, rung: 2, level: 1, r: 1, step: true, ...over });

  it('asks a return after every other card, however high its p', () => {
    // The listening card's p is 0.625, the return's typed meaning 1.
    const plan = planCards([at(0, SR, 1, { r: 0.25 }), back(1, WR)], ALL);
    expect(plan.order).toEqual([0, 1]);
    expect(plan.types).toEqual(['listen_choice', 'typed_meaning']);
  });

  it('keeps the highest p first among the returns', () => {
    const plan = planCards([pick(0), back(1, WP, { r: 0.8 }), back(2, WR)], ALL);
    expect(plan.order).toEqual([0, 2, 1]);
    expect(plan.types).toEqual(['multiple_choice', 'typed_meaning', 'typed_translation']);
  });

  it('starts the returns with a type other than the card before them, where one can', () => {
    const plan = planCards([at(0, WR, 2, { r: 0.9 }), back(1, WR), back(2, WP, { r: 0.95 })], ALL);
    expect(plan.types).toEqual(['typed_meaning', 'typed_translation', 'typed_meaning']);
    expect(plan.order).toEqual([0, 2, 1]);
  });

  it('asks every return as recall past the per-type limit, and counts them toward it for the other cards', () => {
    // Nine words met in one session come back in the next: written receptive's one
    // recall type takes them all. A due word's typed meaning then falls back.
    const list = [pick(0), ...Array.from({ length: 9 }, (_, i) => back(i + 1, WR)), at(10, WR, 2)];
    const types = typesByPick(list);
    expect(types.slice(1, 10)).toEqual(Array(9).fill('typed_meaning'));
    expect(types[10]).toBe('multiple_choice');
  });

  it('keeps a return off the board, which still forms from the new words', () => {
    // A return with no memory falls back to a multiple choice, which the board must not take.
    const list = [back(0, WR, { r: null }), pick(1), pick(2), pick(3), pick(4), at(5, WP, 2), back(6, WP)];
    const plan = planCards(list, ALL);
    expect(plan.board).toEqual({ start: 0 });
    expect(plan.order.slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(plan.order.slice(5)).toEqual([0, 6]);
  });
});

// Phase 55 (spec D2).
describe('ladderCards', () => {
  it('opens with meet, read aloud and letter tiles when the session can speak and the form takes tiles', () => {
    expect(ladderCards({ tiles: true, speakable: true }, true)).toEqual({
      intro: ['meet', 'read_aloud', 'letter_tiles'],
      practice: ['multiple_choice', 'reverse_choice', 'typed_translation'],
    });
  });

  it('leaves the read aloud out when the session cannot speak', () => {
    expect(ladderCards({ tiles: true, speakable: true }, false).intro).toEqual(['meet', 'letter_tiles']);
  });

  it('takes a typed translation in place of tiles when the form cannot take them', () => {
    expect(ladderCards({ tiles: false, speakable: true }, true).intro).toEqual(['meet', 'read_aloud', 'typed_translation']);
    expect(ladderCards({ tiles: false, speakable: true }, false).intro).toEqual(['meet', 'typed_translation']);
  });

  it('leaves the read aloud out when the form cannot be said', () => {
    expect(ladderCards({ tiles: true, speakable: false }, true).intro).toEqual(['meet', 'letter_tiles']);
    expect(ladderCards({ tiles: false, speakable: false }, true).intro).toEqual(['meet', 'typed_translation']);
  });

  it('has the same three practice cards whatever the pick and the session', () => {
    for (const tiles of [true, false]) {
      for (const speakable of [true, false]) {
        for (const speaking of [true, false]) {
          expect(ladderCards({ tiles, speakable }, speaking).practice).toEqual(['multiple_choice', 'reverse_choice', 'typed_translation']);
        }
      }
    }
  });
});

// Phase 54 (spec D3, D5); phase 55 (spec D2, D3).
describe('planCards: a ladder', () => {
  /** The cards of a ladder with tiles and a speakable form, in a session that can speak. */
  const INTRO: readonly QuestionType[] = ['meet', 'read_aloud', 'letter_tiles'];
  const PRACTICE: readonly QuestionType[] = ['multiple_choice', 'reverse_choice', 'typed_translation'];
  const LADDER_ALL: readonly QuestionType[] = [...INTRO, ...PRACTICE];
  /** The same in a session that cannot speak. */
  const LADDER_NONE: readonly QuestionType[] = ['meet', 'letter_tiles', ...PRACTICE];

  /** A ladder pick: a new word, written receptive, with all of its cards. */
  const ladder = (n: number, over: Partial<PlanPick> = {}): PlanPick => pick(n, { ladder: true, ...over });
  const back = (n: number, dimension: Dimension, over: Partial<PlanPick> = {}): PlanPick =>
    pick(n, { dimension, rung: 2, level: 1, r: 1, step: true, ...over });

  /** The types a pick is asked as, in the order of the plan. */
  const typesOf = (plan: ReturnType<typeof planCards>, index: number) => plan.types.filter((_, position) => plan.order[position] === index);
  /** The positions of the plan whose card is the pick's. */
  const positionsOf = (plan: ReturnType<typeof planCards>, index: number) =>
    plan.order.flatMap((at, position) => (at === index ? [position] : []));
  /** Whether two cards of one pick are asked one after the other. */
  const adjacent = (plan: ReturnType<typeof planCards>) => plan.order.flatMap((index, position) => (position > 0 && plan.order[position - 1] === index ? [position] : []));
  /** The same, but for the cards of an intro stage, which are one unit and always back to back:
   *  `intro` is how many cards the stage has, the first of a pick's cards. */
  const adjacentBeyondIntro = (plan: ReturnType<typeof planCards>, intro: number) =>
    adjacent(plan).filter((position) => positionsOf(plan, plan.order[position]).indexOf(position) >= intro);

  /** Six known words, whatever their dimension and rung, none of them a multiple choice. */
  const others = (from: number) => [
    at(from, WP, 1),
    at(from + 1, WP, 2),
    at(from + 2, SP, 1),
    at(from + 3, SR, 1),
    at(from + 4, WR, 2),
    at(from + 5, SK, 1),
  ];

  it('is the intro cards then the three practice cards, in order, and leaves the other picks the types they get today', () => {
    const six = others(1);
    const plan = planCards([ladder(0), ...six], ALL);
    expect(typesOf(plan, 0)).toEqual(LADDER_ALL);
    expect(plan.order).toHaveLength(6 + 6);
    expect(typesByPick([ladder(0), ...six]).slice(1)).toEqual(typesByPick(six));
  });

  it('asks the ladder types whatever the pick says of its rung, its memory, its level and its dimension', () => {
    // A word missed in its ladder comes back as one, with the memory that miss wrote (spec D2).
    const again = ladder(0, { rung: 2, r: 0.9, level: 3 });
    expect(typesOf(planCards([again, pick(1)], ALL), 0)).toEqual(LADDER_ALL);
    // Nor do the session's flags change it, but for the read aloud (spec D2).
    expect(typesOf(planCards([again, pick(1)], NONE), 0)).toEqual(LADDER_NONE);
    expect(typesOf(planCards([ladder(0, { dimension: SP, rung: 2, r: 0.5, tiles: false, speakable: false })], NONE), 0)).toEqual([
      'meet',
      'typed_translation',
      ...PRACTICE,
    ]);
  });

  it('asks a form without tiles to type its word in the intro, and one that cannot be said no read aloud', () => {
    const phrase = ladder(0, { tiles: false });
    expect(typesOf(planCards([phrase, pick(1)], ALL), 0)).toEqual(['meet', 'read_aloud', 'typed_translation', ...PRACTICE]);
    const mute = ladder(0, { speakable: false });
    expect(typesOf(planCards([mute, pick(1)], ALL), 0)).toEqual(LADDER_NONE);
  });

  it('keeps the read aloud of a session of one ladder, which the one-word rule only takes from the speaking pick', () => {
    const plan = planCards([ladder(0)], ALL);
    expect(plan.types).toEqual(LADDER_ALL);
    expect(plan.order).toEqual([0, 0, 0, 0, 0, 0]);
    // A session of one word that is not a ladder still gets no speaking card (phase 25).
    expect(planCards([at(0, SK, 1)], ALL).types).toEqual(['multiple_choice']);
  });

  it('does not count toward MAX_PER_TYPE: the other picks keep the types they get without it', () => {
    const five = Array.from({ length: 5 }, (_, i) => at(2 + i, WP, 1, { clozeGap: false }));
    const plan = planCards([ladder(0), ladder(1), ...five], ALL);
    const types = typesByPick(five);
    expect(count(types, 'reverse_choice')).toBe(MAX_PER_TYPE);
    expect(count(types, 'letter_tiles')).toBe(1);
    // Beside the two ladders' reverse choices, which are not among the four.
    const asked = plan.order.flatMap((index, position) => (index >= 2 ? [plan.types[position]] : []));
    expect(count(asked, 'reverse_choice')).toBe(MAX_PER_TYPE);
    expect(count(asked, 'letter_tiles')).toBe(1);
    expect(count(plan.types, 'reverse_choice')).toBe(MAX_PER_TYPE + 2);
    expect(typesOf(plan, 0)).toEqual(LADDER_ALL);
    expect(typesOf(plan, 1)).toEqual(LADDER_ALL);
  });

  it('never puts its multiple choice on a board, which forms from the other new words', () => {
    // Three ladders and four new words: seven picks, and the board is the four.
    const list = [ladder(0), ladder(1), ladder(2), pick(3), pick(4), pick(5), pick(6)];
    const plan = planCards(list, ALL);
    expect(plan.board).not.toBeNull();
    const start = plan.board!.start;
    expect(plan.order.slice(start, start + 4).sort()).toEqual([3, 4, 5, 6]);
    expect(plan.types.slice(start, start + 4)).toEqual(Array(4).fill('matching'));
    for (const index of [0, 1, 2]) expect(typesOf(plan, index)).toEqual(LADDER_ALL);
  });

  it('forms no board from its multiple choice: seven picks, only three of them not ladders', () => {
    const plan = planCards([ladder(0), ladder(1), ladder(2), ladder(3), pick(4), pick(5), pick(6)], ALL);
    expect(plan.board).toBeNull();
    expect(plan.types).not.toContain('matching');
    expect(count(plan.types, 'multiple_choice')).toBe(4 + 3);
  });

  it('merges three ladders, nothing else, by stage: every intro stage, then every first practice card, and so on', () => {
    const plan = planCards([ladder(0), ladder(1), ladder(2)], ALL);
    expect(plan.order).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2]);
    expect(plan.types).toEqual([
      ...INTRO,
      ...INTRO,
      ...INTRO,
      ...Array(3).fill('multiple_choice'),
      ...Array(3).fill('reverse_choice'),
      ...Array(3).fill('typed_translation'),
    ]);
    expect(plan.board).toBeNull();
  });

  it('merges two ladders, nothing else: both intro stages, then the practice cards stage by stage', () => {
    const plan = planCards([ladder(0), ladder(1)], ALL);
    expect(plan.order).toEqual([0, 0, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1]);
    expect(plan.types).toEqual([
      ...INTRO,
      ...INTRO,
      'multiple_choice',
      'multiple_choice',
      'reverse_choice',
      'reverse_choice',
      'typed_translation',
      'typed_translation',
    ]);
  });

  it('spreads three ladders evenly through the one other card', () => {
    const plan = planCards([ladder(0), ladder(1), ladder(2), at(3, SR, 1)], ALL);
    expect(plan.order).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 0, 1, 2, 3, 0, 1, 2, 0, 1, 2]);
    expect(plan.types[12]).toBe('listen_choice');
  });

  it('spreads one ladder through three others: its intro stage in a row, one other between each two stages', () => {
    const plan = planCards([ladder(0), at(1, WP, 1), at(2, SR, 1), at(3, SP, 2)], ALL);
    expect(plan.order.map((index) => (index === 0 ? 'L' : 'o'))).toEqual(['L', 'L', 'L', 'o', 'L', 'o', 'L', 'o', 'L']);
    expect(typesOf(plan, 0)).toEqual(LADDER_ALL);
  });

  it.each([
    ['three ladders and one other', 3, 1],
    ['two ladders and four others', 2, 4],
    ['one ladder and three others', 1, 3],
    ['two ladders and three others', 2, 3],
    ['three ladders and six others', 3, 6],
  ])('never asks two cards of one word in a row but the intro stage, with %s, and keeps each ladder in order', (_, ladders, rest) => {
    const list = [...Array.from({ length: ladders }, (_, i) => ladder(i)), ...others(ladders).slice(0, rest)];
    const plan = planCards(list, ALL);
    expect(plan.order).toHaveLength(ladders * 6 + rest);
    expect(adjacentBeyondIntro(plan, INTRO.length)).toEqual([]);
    for (let index = 0; index < ladders; index++) expect(typesOf(plan, index)).toEqual(LADDER_ALL);
    for (let index = ladders; index < list.length; index++) expect(positionsOf(plan, index)).toHaveLength(1);
  });

  it.each([
    ['one ladder and six others', 1, 6],
    ['two ladders and two others', 2, 2],
    ['two ladders and six others', 2, 6],
  ])('keeps each intro stage together, and before its practice cards, with %s', (_, ladders, rest) => {
    const list = [...Array.from({ length: ladders }, (_, i) => ladder(i)), ...others(ladders).slice(0, rest)];
    const plan = planCards(list, ALL);
    for (let index = 0; index < ladders; index++) {
      const at = positionsOf(plan, index);
      // The intro cards sit on consecutive positions, in order; the practice cards follow, apart.
      expect(at.slice(0, INTRO.length)).toEqual(Array.from({ length: INTRO.length }, (_, k) => at[0] + k));
      expect(typesOf(plan, index).slice(0, INTRO.length)).toEqual(INTRO);
      expect(at[INTRO.length]).toBeGreaterThan(at[INTRO.length - 1]);
    }
    expect(adjacentBeyondIntro(plan, INTRO.length)).toEqual([]);
    expect(plan.order).toHaveLength(ladders * 6 + rest);
  });

  it('puts a practice card after another card of its word only when two others cannot part four stages', () => {
    // Three separators are needed and two exist: the ladder ends with two in a row, after both others.
    const plan = planCards([ladder(0), at(1, WP, 1), at(2, SR, 1)], ALL);
    expect(plan.order).toEqual([0, 0, 0, 1, 0, 2, 0, 0]);
    expect(typesOf(plan, 0)).toEqual(LADDER_ALL);
    expect(adjacentBeyondIntro(plan, INTRO.length)).toEqual([7]);
    const last = positionsOf(plan, 0).slice(-2);
    expect(last).toEqual([6, 7]);
    expect(positionsOf(plan, 1)[0]).toBeLessThan(last[0]);
    expect(positionsOf(plan, 2)[0]).toBeLessThan(last[0]);
  });

  it('asks a lone ladder as its six cards in a row', () => {
    const plan = planCards([ladder(0)], ALL);
    expect(plan.order).toEqual([0, 0, 0, 0, 0, 0]);
    expect(plan.types).toEqual(LADDER_ALL);
    expect(plan.board).toBeNull();
  });

  it('asks the returns after every other card, as the last of the cards a ladder merges with', () => {
    // The other cards are 2 (reverse choice) and 3 (listening), then the returns 4 and 5: O = 4,
    // and the stream is eight units (two intro stages and six practice cards), L = 8. The stream
    // places its next unit while (a + ½) / 8 ≤ (b + ½) / 4: I0, 2, I1, P1₀, 3, P1₁, P2₀, 4, P2₁, P3₀, 5, P3₁.
    const list = [ladder(0), ladder(1), at(2, WP, 1), at(3, SR, 1), back(4, WR), back(5, WP, { r: 0.8 })];
    const plan = planCards(list, ALL);
    expect(plan.order).toEqual([0, 0, 0, 2, 1, 1, 1, 0, 3, 1, 0, 4, 1, 0, 5, 1]);
    expect(plan.types).toEqual([
      ...INTRO,
      'reverse_choice',
      ...INTRO,
      'multiple_choice',
      'listen_choice',
      'multiple_choice',
      'reverse_choice',
      'typed_meaning',
      'reverse_choice',
      'typed_translation',
      'typed_translation',
      'typed_translation',
    ]);
    // Still after every card that is neither a return nor a ladder's.
    expect(Math.min(...positionsOf(plan, 4), ...positionsOf(plan, 5))).toBeGreaterThan(Math.max(...positionsOf(plan, 2), ...positionsOf(plan, 3)));
    expect(adjacentBeyondIntro(plan, INTRO.length)).toEqual([]);
  });

  it("puts a lone ladder's return between its intro stage and its first practice card", () => {
    // O = 1, L = 4. The intro stage first (½ / 4 ≤ ½ / 1); the multiple choice would follow it, so
    // the return goes first; then nothing is left to part the three practice cards.
    const plan = planCards([ladder(0), back(1, WR)], ALL);
    expect(plan.order).toEqual([0, 0, 0, 1, 0, 0, 0]);
    expect(plan.types).toEqual([...INTRO, 'typed_meaning', ...PRACTICE]);
  });

  it('parts one ladder with one other card and two returns: only its intro cards in a row', () => {
    // O = 3: the other card, then the returns. L = 4: I, 1, P1, 2, P2, 3, P3.
    const plan = planCards([ladder(0), at(1, WP, 1), back(2, WR), back(3, WP, { r: 0.8 })], ALL);
    expect(plan.order).toEqual([0, 0, 0, 1, 0, 2, 0, 3, 0]);
    expect(adjacentBeyondIntro(plan, INTRO.length)).toEqual([]);
    expect(typesOf(plan, 0)).toEqual(LADDER_ALL);
  });

  it('asks the returns last when the session has no ladder, as before', () => {
    const list = [at(0, WP, 1), at(1, SR, 1), back(2, WR), back(3, WP, { r: 0.8 })];
    const plan = planCards(list, ALL);
    expect(plan.order).toEqual([0, 1, 2, 3]);
    expect(plan.types).toEqual(['reverse_choice', 'listen_choice', 'typed_meaning', 'typed_translation']);
  });

  it('plans a pick without a ladder flag exactly as before', () => {
    // The order test of spec D6: highest p first.
    const list = [at(0, SR, 1, { r: 0.25 }), at(1, WP, 2), at(2, WR, 2, { r: 0.8 })];
    const plan = planCards(list, ALL);
    expect(plan.order).toEqual([1, 2, 0]);
    expect(plan.types).toEqual(['typed_translation', 'typed_meaning', 'listen_choice']);
    expect(planCards(list.map((p) => ({ ...p, ladder: false })), ALL)).toEqual(plan);
    // A new word without the flag is a multiple choice, a card.
    expect(typeOf(pick(0))).toBe('multiple_choice');
    expect(typeOf(pick(0, { ladder: false }))).toBe('multiple_choice');
  });
});
