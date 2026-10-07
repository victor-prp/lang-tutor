import { describe, expect, it } from '@jest/globals';

import { TIERS, planSession, type PlanPick } from './plan';

const pick = (n: number, tiles = true): PlanPick => ({ form: `word${n}`, translation: `מילה${n}`, tiles, speakable: true });
const picks = (count: number, tiles = true) => Array.from({ length: count }, (_, i) => pick(i, tiles));
const ON = { listening: true, speaking: false, ordinal: 0 };
const OFF = { listening: false, speaking: false, ordinal: 0 };
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
    expect(planSession(picks(10), { listening: true, speaking: false, ordinal: 1 }).types).toEqual([
      'listen_choice', 'letter_tiles', 'dictation',
      ...BOARD,
      'typed_meaning', 'reverse_choice', 'typed_translation',
    ]);
  });

  it('has no board below seven words, and opens on phase 23 cycle', () => {
    const plan = planSession(picks(6), OFF);
    expect(plan.board).toBeNull();
    expect(plan.types).toEqual([
      'multiple_choice', 'reverse_choice', 'typed_translation',
      'typed_meaning', 'letter_tiles', 'typed_translation',
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
      'typed_meaning', 'reverse_choice', 'typed_translation',
    ]);
  });

  // Review Focus 2.
  it('never puts two senses of one word, or two words with one meaning, on a board', () => {
    const list: PlanPick[] = [
      pick(0), pick(1), pick(2),
      { form: 'lock', translation: 'מנעול', tiles: true, speakable: true },
      { form: 'Lock', translation: 'טירה', tiles: true, speakable: true },
      { form: 'big', translation: 'גדול', tiles: true, speakable: true },
      { form: 'large', translation: 'גדול', tiles: true, speakable: true },
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
      { form: 'lock', translation: 'מנעול', tiles: true, speakable: true },
      { form: 'castle', translation: 'טירה', tiles: true, speakable: true },
      { form: 'big', translation: 'גדול', tiles: true, speakable: true },
      { form: 'large', translation: 'גָּדוֹל.', tiles: true, speakable: true },
      pick(7), pick(8), pick(9),
    ];
    const plan = planSession(list, OFF);
    expect(plan.board).toEqual({ start: 3 });
    expect(plan.order).toEqual([0, 1, 2, 3, 4, 5, 7, 6, 8, 9]);
  });

  it('has no board when four distinct words cannot be found', () => {
    const same = Array.from({ length: 8 }, (_, i) => ({ form: i < 3 ? `w${i}` : 'lock', translation: `מ${i}`, tiles: true, speakable: true }));
    const plan = planSession(same, OFF);
    expect(plan.board).toBeNull();
    expect(plan.types).not.toContain('matching');
  });

  it('never gives two cards in a row one type, at any size, ordinal or listening', () => {
    for (let n = 1; n <= 10; n++) {
      for (const ordinal of [0, 1, 2, 3]) {
        for (const listening of [true, false]) {
          const { types, board } = planSession(picks(n), { listening, speaking: false, ordinal });
          // A board is one card: keep its first word only.
          const cards = types.filter((_, i) => !(board && i > board.start && i < board.start + 4));
          for (let i = 1; i < cards.length; i++) expect(cards[i]).not.toBe(cards[i - 1]);
        }
      }
    }
  });
});

describe('phase 25 speaking cards in the plan', () => {
  const ten = Array.from({ length: 10 }, (_, i) => ({
    form: `word${i}`,
    translation: `מילה${i}`,
    tiles: true,
    speakable: true,
  }));

  it('with speaking off, plans exactly what phase 24 planned', () => {
    for (const ordinal of [0, 1, 2, 3, 4, 5]) {
      for (const listening of [false, true]) {
        const types = planSession(ten, { listening, speaking: false, ordinal }).types;
        expect(types).not.toContain('read_aloud');
        expect(types).not.toContain('say_translation');
      }
    }
    expect(planSession(ten, { listening: true, speaking: false, ordinal: 2 }).types[7]).toBe('multiple_choice');
  });

  it('with listening off and speaking on, ordinal 0 asks read aloud at 8 and say the translation at 10', () => {
    expect(planSession(ten, { listening: false, speaking: true, ordinal: 0 }).types).toEqual([
      'multiple_choice',
      'reverse_choice',
      'typed_translation',
      'matching',
      'matching',
      'matching',
      'matching',
      'read_aloud',
      'letter_tiles',
      'say_translation',
    ]);
  });

  it('four sessions in a row show both speaking cards', () => {
    const seen = new Set([0, 1, 2, 3].flatMap((ordinal) => planSession(ten, { listening: true, speaking: true, ordinal }).types));
    expect(seen).toContain('read_aloud');
    expect(seen).toContain('say_translation');
  });

  it('never gives a speaking card to a phrase of five words', () => {
    const long = ten.map((pick) => ({ ...pick, speakable: false }));
    const types = [0, 1, 2, 3].flatMap((ordinal) => planSession(long, { listening: false, speaking: true, ordinal }).types);
    expect(types).not.toContain('read_aloud');
    expect(types).not.toContain('say_translation');
  });

  it('gives a one-word session no speaking card', () => {
    for (const ordinal of [0, 1, 2]) {
      expect(planSession([ten[0]], { listening: true, speaking: true, ordinal }).types).toEqual([
        expect.not.stringMatching(/read_aloud|say_translation/),
      ]);
    }
  });

  it('never puts two cards of one type in a row, over every size, with speaking on', () => {
    for (let size = 1; size <= 10; size++) {
      for (const ordinal of [0, 1, 2, 3]) {
        const types = planSession(ten.slice(0, size), { listening: true, speaking: true, ordinal }).types;
        types.forEach((type, i) => {
          if (i > 0 && type !== 'matching') expect(type).not.toBe(types[i - 1]);
        });
      }
    }
  });
});

describe('typed_meaning in the recognise tier (phase 27 D9)', () => {
  it('is the last type of the recognise tier', () => {
    expect(TIERS[0]).toEqual(['multiple_choice', 'listen_choice', 'read_aloud', 'typed_meaning']);
  });
  it('is chosen when its turn comes, and when listening falls through to it', () => {
    // Four picks, ordinal 0, no listening, no speaking: the second run's
    // recognise card prefers listen_choice, which falls through to
    // typed_meaning (the next eligible in the tier's order).
    const plan = planSession(picks(4), { listening: false, speaking: false, ordinal: 0 });
    expect(plan.types).toEqual(['multiple_choice', 'reverse_choice', 'typed_translation', 'typed_meaning']);
  });
  it('never puts two cards of a type in a row, over sizes 1 to 10 and ordinals 0 to 4', () => {
    for (let size = 1; size <= 10; size++) {
      for (let ordinal = 0; ordinal <= 4; ordinal++) {
        for (const flags of [{ listening: false, speaking: false }, { listening: true, speaking: true }]) {
          const types = planSession(picks(size), { ...flags, ordinal }).types;
          types.forEach((type, i) => {
            if (i > 0) expect(type === types[i - 1] && type !== 'matching').toBe(false);
          });
        }
      }
    }
  });
});
