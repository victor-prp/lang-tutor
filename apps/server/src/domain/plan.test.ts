import { describe, expect, it } from '@jest/globals';

import { planSession, type PlanPick } from './plan';

const pick = (n: number, tiles = true): PlanPick => ({ form: `word${n}`, translation: `מילה${n}`, tiles });
const picks = (count: number, tiles = true) => Array.from({ length: count }, (_, i) => pick(i, tiles));
const ON = { listening: true, ordinal: 0 };
const OFF = { listening: false, ordinal: 0 };
const BOARD = ['matching', 'matching', 'matching', 'matching'];

describe('planSession (spec D3, D4, D10)', () => {
  it('lays ten words out as a run, the board and a run, with six different single types', () => {
    const plan = planSession(picks(10), ON);
    expect(plan.types).toEqual([
      'multiple_choice', 'reverse_choice', 'typed_translation',
      ...BOARD,
      'listen_choice', 'letter_tiles', 'dictation',
    ]);
    expect(plan.board).toEqual({ start: 3 });
    expect(plan.order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('rotates by ordinal, so two ten-word sessions in a row show every type', () => {
    expect(planSession(picks(10), { listening: true, ordinal: 1 }).types).toEqual([
      'listen_choice', 'letter_tiles', 'dictation',
      ...BOARD,
      'multiple_choice', 'reverse_choice', 'typed_translation',
    ]);
  });

  it('has no board below seven words, and opens on phase 23 cycle', () => {
    const plan = planSession(picks(6), OFF);
    expect(plan.board).toBeNull();
    expect(plan.types).toEqual([
      'multiple_choice', 'reverse_choice', 'typed_translation',
      'multiple_choice', 'letter_tiles', 'typed_translation',
    ]);
  });

  it('places the board after the first run at seven, eight and nine words', () => {
    for (const n of [7, 8, 9]) {
      const plan = planSession(picks(n), OFF);
      expect(plan.board).toEqual({ start: 3 });
      expect(plan.types.slice(3, 7)).toEqual(BOARD);
      expect(plan.types).toHaveLength(n);
    }
  });

  it('falls forward within a tier to an eligible type, ending at the first', () => {
    const plan = planSession(picks(10, false), OFF);
    expect(plan.types.filter((type) => type !== 'matching')).toEqual([
      'multiple_choice', 'reverse_choice', 'typed_translation',
      'multiple_choice', 'reverse_choice', 'typed_translation',
    ]);
  });

  // Review Focus 2.
  it('never puts two senses of one word, or two words with one meaning, on a board', () => {
    const list: PlanPick[] = [
      pick(0), pick(1), pick(2),
      { form: 'lock', translation: 'מנעול', tiles: true },
      { form: 'Lock', translation: 'טירה', tiles: true },
      { form: 'big', translation: 'גדול', tiles: true },
      { form: 'large', translation: 'גדול', tiles: true },
      pick(7), pick(8), pick(9),
    ];
    const plan = planSession(list, OFF);
    expect(plan.board).toEqual({ start: 3 });
    expect(plan.order).toEqual([0, 1, 2, 3, 5, 7, 8, 4, 6, 9]);
  });

  // Final review: "the same" is distractors' comparable, not just case.
  it('treats a meaning that differs only by points or a full stop as the same on a board', () => {
    const list: PlanPick[] = [
      pick(0), pick(1), pick(2),
      { form: 'lock', translation: 'מנעול', tiles: true },
      { form: 'castle', translation: 'טירה', tiles: true },
      { form: 'big', translation: 'גדול', tiles: true },
      { form: 'large', translation: 'גָּדוֹל.', tiles: true },
      pick(7), pick(8), pick(9),
    ];
    const plan = planSession(list, OFF);
    expect(plan.board).toEqual({ start: 3 });
    expect(plan.order).toEqual([0, 1, 2, 3, 4, 5, 7, 6, 8, 9]);
  });

  it('has no board when four distinct words cannot be found', () => {
    const same = Array.from({ length: 8 }, (_, i) => ({ form: i < 3 ? `w${i}` : 'lock', translation: `מ${i}`, tiles: true }));
    const plan = planSession(same, OFF);
    expect(plan.board).toBeNull();
    expect(plan.types).not.toContain('matching');
  });

  it('never gives two cards in a row one type, at any size, ordinal or listening', () => {
    for (let n = 1; n <= 10; n++) {
      for (const ordinal of [0, 1, 2, 3]) {
        for (const listening of [true, false]) {
          const { types, board } = planSession(picks(n), { listening, ordinal });
          // A board is one card: keep its first word only.
          const cards = types.filter((_, i) => !(board && i > board.start && i < board.start + 4));
          for (let i = 1; i < cards.length; i++) expect(cards[i]).not.toBe(cards[i - 1]);
        }
      }
    }
  });
});
