import { describe, expect, it } from '@jest/globals';
import type { Dimension, QuestionType } from '@lang-tutor/core/domain';

import { expectedSuccess } from './choose';
import { CARD_TARGET } from './chooseConstants';
import { BOARD_MIN_PICKS, MAX_PER_TYPE, RUNGS, planCards, type PlanInput, type PlanPick } from './plan';

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
