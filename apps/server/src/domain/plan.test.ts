import { describe, expect, it } from '@jest/globals';

import { TIERS, planSession, type PlanPick } from './plan';

const pick = (n: number, tiles = true, clozeGap = true): PlanPick => ({ form: `word${n}`, translation: `מילה${n}`, tiles, speakable: true, clozeGap });
const picks = (count: number, tiles = true, clozeGap = true) => Array.from({ length: count }, (_, i) => pick(i, tiles, clozeGap));
const ON = { listening: true, speaking: false, ordinal: 0 };
const OFF = { listening: false, speaking: false, ordinal: 0 };
const BOARD = ['matching', 'matching', 'matching', 'matching'];

describe('planSession (spec D3, D4, D10)', () => {
  it('lays ten words out as a run, the board and a run, with six different single types', () => {
    const plan = planSession(picks(10), ON);
    expect(plan.types).toEqual([
      'multiple_choice', 'reverse_choice', 'typed_translation',
      ...BOARD,
      'listen_choice', 'cloze_choice', 'cloze_typed',
    ]);
    expect(plan.board).toEqual({ start: 3 });
    expect(plan.order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('rotates by ordinal, so two ten-word sessions in a row show every type', () => {
    expect(planSession(picks(10), { listening: true, speaking: false, ordinal: 1 }).types).toEqual([
      'listen_choice', 'cloze_choice', 'cloze_typed',
      ...BOARD,
      'typed_meaning', 'letter_tiles', 'dictation',
    ]);
  });

  it('has no board below seven words, and opens on phase 23 cycle', () => {
    const plan = planSession(picks(6), OFF);
    expect(plan.board).toBeNull();
    expect(plan.types).toEqual([
      'multiple_choice', 'reverse_choice', 'typed_translation',
      'typed_meaning', 'cloze_choice', 'cloze_typed',
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
    const plan = planSession(picks(10, false, false), OFF);
    expect(plan.types.filter((type) => type !== 'matching')).toEqual([
      'multiple_choice', 'reverse_choice', 'typed_translation',
      'typed_meaning', 'reverse_choice', 'cloze_typed',
    ]);
  });

  // Review Focus 2.
  it('never puts two senses of one word, or two words with one meaning, on a board', () => {
    const list: PlanPick[] = [
      pick(0), pick(1), pick(2),
      { form: 'lock', translation: 'מנעול', tiles: true, speakable: true, clozeGap: true },
      { form: 'Lock', translation: 'טירה', tiles: true, speakable: true, clozeGap: true },
      { form: 'big', translation: 'גדול', tiles: true, speakable: true, clozeGap: true },
      { form: 'large', translation: 'גדול', tiles: true, speakable: true, clozeGap: true },
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
      { form: 'lock', translation: 'מנעול', tiles: true, speakable: true, clozeGap: true },
      { form: 'castle', translation: 'טירה', tiles: true, speakable: true, clozeGap: true },
      { form: 'big', translation: 'גדול', tiles: true, speakable: true, clozeGap: true },
      { form: 'large', translation: 'גָּדוֹל.', tiles: true, speakable: true, clozeGap: true },
      pick(7), pick(8), pick(9),
    ];
    const plan = planSession(list, OFF);
    expect(plan.board).toEqual({ start: 3 });
    expect(plan.order).toEqual([0, 1, 2, 3, 4, 5, 7, 6, 8, 9]);
  });

  it('has no board when four distinct words cannot be found', () => {
    const same = Array.from({ length: 8 }, (_, i) => ({ form: i < 3 ? `w${i}` : 'lock', translation: `מ${i}`, tiles: true, speakable: true, clozeGap: true }));
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
    clozeGap: true,
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

  it('with listening off and speaking on, ordinal 0 asks read aloud at 8 and the two cloze cards after it', () => {
    expect(planSession(ten, { listening: false, speaking: true, ordinal: 0 }).types).toEqual([
      'multiple_choice',
      'reverse_choice',
      'typed_translation',
      'matching',
      'matching',
      'matching',
      'matching',
      'read_aloud',
      'cloze_choice',
      'cloze_typed',
    ]);
  });

  it('four sessions in a row show both speaking cards', () => {
    const seen = new Set([0, 1, 2, 3].flatMap((ordinal) => planSession(ten, { listening: true, speaking: true, ordinal }).types));
    expect(seen).toContain('read_aloud');
    expect(seen).toContain('say_translation');
  });

  it('never gives a speaking card to a phrase of five words', () => {
    const long = ten.map((pick) => ({ ...pick, speakable: false, clozeGap: true }));
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

describe('the sentence cards in the plan (phase 27 D8, D9)', () => {
  it('has the tiers of the spec', () => {
    expect(TIERS).toEqual([
      ['multiple_choice', 'listen_choice', 'read_aloud', 'typed_meaning'],
      ['reverse_choice', 'cloze_choice', 'letter_tiles'],
      ['typed_translation', 'cloze_typed', 'dictation', 'say_translation', 'sentence_translation'],
    ]);
  });

  const ALL = { listening: true, speaking: true };

  // Hand-derived. Ten picks: a board after the first run, singles s0..s5; single s
  // is in tier s % 3, run floor(s / 3), preferred index (ordinal + run) % tier length.
  it('lays out ordinal 1, ten words, everything eligible', () => {
    // s0 A (4) pref 1 listen_choice; s1 B (3) pref 1 cloze_choice; s2 C (5) pref 1 cloze_typed;
    // s3 A pref 2 read_aloud; s4 B pref 2 letter_tiles; s5 C pref 2 dictation.
    expect(planSession(picks(10), { ...ALL, ordinal: 1 }).types).toEqual([
      'listen_choice', 'cloze_choice', 'cloze_typed',
      ...BOARD,
      'read_aloud', 'letter_tiles', 'dictation',
    ]);
  });

  it('reaches sentence_translation at ordinal 4', () => {
    // s0 A pref 0 multiple_choice; s1 B pref 1 cloze_choice; s2 C pref 4 sentence_translation;
    // s3 A pref 1 listen_choice; s4 B pref 2 letter_tiles; s5 C pref 0 typed_translation.
    expect(planSession(picks(10), { ...ALL, ordinal: 4 }).types).toEqual([
      'multiple_choice', 'cloze_choice', 'sentence_translation',
      ...BOARD,
      'listen_choice', 'letter_tiles', 'typed_translation',
    ]);
  });

  it('needs a gap for the cloze choice, and a speakable form for the two sentence types', () => {
    // Six words, ordinal 4, all on. s1 B pref 1: no gap, so letter_tiles. s2 C pref 4:
    // not speakable, so sentence_translation falls to the wrap-around, typed_translation.
    const list = [pick(0), { ...pick(1), clozeGap: false }, { ...pick(2), speakable: false }, pick(3), pick(4), pick(5)];
    const types = planSession(list, { ...ALL, ordinal: 4 }).types;
    expect(types.slice(0, 3)).toEqual(['multiple_choice', 'letter_tiles', 'typed_translation']);
    // And over every ordinal, a form that cannot be said never gets the two sentence types.
    const unspeakable = picks(6).map((p) => ({ ...p, speakable: false }));
    const all = [0, 1, 2, 3, 4].flatMap((ordinal) => planSession(unspeakable, { ...ALL, ordinal }).types);
    expect(all).not.toContain('cloze_typed');
    expect(all).not.toContain('sentence_translation');
    const noGap = [0, 1, 2, 3, 4].flatMap((ordinal) => planSession(picks(6, true, false), { ...ALL, ordinal }).types);
    expect(noGap).not.toContain('cloze_choice');
  });

  it('never gives two cards in a row one type, over sizes 1 to 10, ordinals 0 to 5 and every flag', () => {
    for (let size = 1; size <= 10; size++) {
      for (let ordinal = 0; ordinal <= 5; ordinal++) {
        for (const listening of [false, true]) {
          for (const speaking of [false, true]) {
            for (const clozeGap of [false, true]) {
              for (const speakable of [false, true]) {
                const list = picks(size, true, clozeGap).map((p) => ({ ...p, speakable }));
                const types = planSession(list, { listening, speaking, ordinal }).types;
                types.forEach((type, i) => {
                  if (i > 0) expect(type === types[i - 1] && type !== 'matching').toBe(false);
                });
              }
            }
          }
        }
      }
    }
  });
});
