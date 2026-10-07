import { describe, expect, it } from '@jest/globals';
import { DIMENSIONS, type Dimension } from '@lang-tutor/core/domain';

import {
  advance,
  daysBetween,
  evaluateSession,
  evidenceFor,
  progressChanges,
  READ_ALOUD_MAX_LEVEL,
  type AnsweredQuestion,
  type Evidence,
  type ProgressRow,
  type SnapshotRead,
} from './progress';

const row = (over: Partial<ProgressRow> = {}): ProgressRow => ({
  senseId: 's1',
  dimension: 'written_receptive',
  level: 1,
  lastStepOn: null,
  lastWrongOn: null,
  ...over,
});
const right: Evidence = { dimension: 'written_receptive', correct: true, cap: null };
const wrong: Evidence = { ...right, correct: false };
const cappedRight: Evidence = { ...right, cap: 3 };
const D = '2026-10-05';

describe('daysBetween', () => {
  it.each([
    ['2026-10-05', '2026-10-05', 0],
    ['2026-10-05', '2026-10-06', 1],
    ['2026-10-31', '2026-11-01', 1],
    ['2026-12-31', '2027-01-01', 1],
    ['2028-02-28', '2028-03-01', 2],
    ['2026-10-14', '2026-11-04', 21],
  ])('counts %s to %s as %i', (from, to, days) => {
    expect(daysBetween(from, to)).toBe(days);
  });
});

describe('evidenceFor', () => {
  it('reads a multiple-choice answer as uncapped written_receptive evidence', () => {
    expect(evidenceFor({ senseId: 's1', type: 'multiple_choice', correct: true })).toEqual([right]);
    expect(evidenceFor({ senseId: 's1', type: 'multiple_choice', correct: false })).toEqual([wrong]);
  });
});

// Phase 23: spec D6, every row.
describe('evidenceFor, every type and verdict', () => {
  it.each([
    [{ senseId: 's', type: 'multiple_choice', correct: true }, [['written_receptive', true, null]]],
    [{ senseId: 's', type: 'multiple_choice', correct: false }, [['written_receptive', false, null]]],
    [
      { senseId: 's', type: 'reverse_choice', correct: true },
      [
        ['written_receptive', true, null],
        ['written_productive', true, 3],
      ],
    ],
    [{ senseId: 's', type: 'reverse_choice', correct: false }, [['written_productive', false, 3]]],
    [
      { senseId: 's', type: 'typed_translation', verdict: 'exact' },
      [
        ['written_receptive', true, null],
        ['written_productive', true, null],
        ['spelling', true, null],
      ],
    ],
    [
      { senseId: 's', type: 'typed_translation', verdict: 'near_miss' },
      [
        ['written_receptive', true, null],
        ['written_productive', true, null],
        ['spelling', false, null],
      ],
    ],
    [{ senseId: 's', type: 'typed_translation', verdict: 'alternative' }, []],
    [{ senseId: 's', type: 'typed_translation', verdict: 'wrong' }, [['written_productive', false, null]]],
  ])('%o gives %j', (answer, expected) => {
    expect(
      evidenceFor(answer as AnsweredQuestion).map((piece) => [piece.dimension, piece.correct, piece.cap]),
    ).toEqual(expected);
  });
});

describe('advance', () => {
  it('rises from level 1 on the first all-correct day', () => {
    expect(advance(row(), [right], D)).toEqual(row({ level: 2, lastStepOn: D }));
  });

  it.each([
    [2, '2026-10-05', '2026-10-06', 3],
    [3, '2026-10-06', '2026-10-13', 4],
    [3, '2026-10-06', '2026-10-12', 3],
    [4, '2026-10-14', '2026-11-04', 5],
    [4, '2026-10-14', '2026-11-03', 4],
  ])('from level %i, last step %s, on %s: level %i', (level, lastStepOn, day, expected) => {
    expect(advance(row({ level, lastStepOn }), [right], day).level).toBe(expected);
  });

  it('measures the gap from a mistake later than the last step', () => {
    const r = row({ level: 3, lastStepOn: '2026-10-06', lastWrongOn: '2026-10-07' });
    expect(advance(r, [right], '2026-10-13').level).toBe(3);
    expect(advance(r, [right], '2026-10-14').level).toBe(4);
  });

  it('records a wrong answer and never lowers the level', () => {
    const r = row({ level: 3, lastStepOn: '2026-10-01' });
    expect(advance(r, [wrong], D)).toEqual({ ...r, lastWrongOn: D });
  });

  // Review Focus 3: a sense asked twice in one session, right then wrong.
  it('does not step on a day with a wrong answer beside a right one', () => {
    expect(advance(row(), [right, wrong], D)).toEqual(row({ lastWrongOn: D }));
  });

  it('does not step after a mistake earlier the same day', () => {
    const r = row({ lastWrongOn: D });
    expect(advance(r, [right], D)).toBe(r);
  });

  it('steps at most once a day', () => {
    const r = row({ level: 2, lastStepOn: D });
    expect(advance(r, [right], D)).toBe(r);
  });

  it('never passes level 5', () => {
    const r = row({ level: 5, lastStepOn: '2026-01-01' });
    expect(advance(r, [right], D)).toBe(r);
  });

  it('carries capped evidence to level 3 and no further', () => {
    expect(advance(row({ level: 2, lastStepOn: '2026-10-01' }), [cappedRight], D).level).toBe(3);
    const atCap = row({ level: 3, lastStepOn: '2026-09-01' });
    expect(advance(atCap, [cappedRight], D)).toBe(atCap);
  });

  it('lifts the cap when one right piece is uncapped', () => {
    expect(advance(row({ level: 3, lastStepOn: '2026-09-01' }), [cappedRight, right], D).level).toBe(4);
  });

  it('changes nothing without evidence', () => {
    const r = row({ level: 2 });
    expect(advance(r, [], D)).toBe(r);
  });

  it('keeps the same row when a repeated wrong day changes nothing', () => {
    const r = row({ lastWrongOn: D });
    expect(advance(r, [wrong], D)).toBe(r);
  });
});

const fiveRows = (senseId: string, over: Partial<ProgressRow> = {}): ProgressRow[] =>
  DIMENSIONS.map((dimension) => row({ senseId, dimension, ...over }));
const answer = (senseId: string, correct: boolean): AnsweredQuestion => ({
  senseId,
  type: 'multiple_choice',
  correct,
});

describe('evaluateSession', () => {
  it('steps the right senses, records the wrong ones, and snapshots every dimension of each', () => {
    const rows = [...fiveRows('s1'), ...fiveRows('s2'), ...fiveRows('s3')];
    const outcome = evaluateSession(rows, [answer('s1', true), answer('s1', true), answer('s2', true), answer('s2', false)], D);

    expect(outcome.changed).toEqual([
      row({ senseId: 's1', level: 2, lastStepOn: D }),
      row({ senseId: 's2', lastWrongOn: D }),
    ]);
    expect(outcome.snapshot).toHaveLength(10);
    expect(outcome.snapshot.filter((s) => s.levelAfter !== s.levelBefore)).toEqual([
      { senseId: 's1', dimension: 'written_receptive', levelBefore: 1, levelAfter: 2 },
    ]);
    expect(outcome.snapshot.some((s) => s.senseId === 's3')).toBe(false);
  });

  it('ignores answers about a sense that has no rows, an unsaved one', () => {
    expect(evaluateSession(fiveRows('s1'), [answer('sX', true)], D)).toEqual({ changed: [], snapshot: [] });
  });

  it('does not count a skipped card as practised (spec D7), but does count an understood one', () => {
    const rows = [...fiveRows('s1'), ...fiveRows('s2')];
    const outcome = evaluateSession(
      rows,
      [
        { senseId: 's1', type: 'read_aloud', verdict: 'skipped' },
        { senseId: 's2', type: 'read_aloud', verdict: 'understood' },
      ],
      D,
    );
    expect(outcome.snapshot.some((s) => s.senseId === 's1')).toBe(false);
    expect(outcome.snapshot.filter((s) => s.senseId === 's2')).toHaveLength(5);
  });
});

describe('evaluateSession, reverse choice only', () => {
  // Phase 23 (spec D6): recognition of the form evidences productive knowledge
  // only up to level 3, however many days it is right.
  it('carries written_productive to 3 and no further', () => {
    let rows = fiveRows('s1');
    for (const day of ['2026-10-01', '2026-10-02', '2026-10-09', '2026-10-30', '2026-11-30']) {
      const outcome = evaluateSession(rows, [{ senseId: 's1', type: 'reverse_choice', correct: true }], day);
      const changed = new Map(outcome.changed.map((r) => [r.dimension, r]));
      rows = rows.map((r) => changed.get(r.dimension) ?? r);
    }
    const level = (d: Dimension) => rows.find((r) => r.dimension === d)!.level;
    expect(level('written_productive')).toBe(3);
    expect(level('written_receptive')).toBe(5);
    expect(level('spelling')).toBe(1);
  });
});

describe('progressChanges', () => {
  const read = (senseId: string, position: number, dimension: Dimension, before: number, after: number): SnapshotRead => ({
    senseId,
    dimension,
    levelBefore: before,
    levelAfter: after,
    form: `form-${senseId}`,
    translation: `tr-${senseId}`,
    position,
  });

  it('gives one change per sense, as badges over the live dimensions, in session order', () => {
    const rows = [
      ...DIMENSIONS.map((d) => read('s1', 3, d, 1, d === 'written_receptive' ? 2 : 1)),
      ...DIMENSIONS.map((d) => read('s2', 0, d, 2, 2)),
    ];
    expect(progressChanges(rows, ['written_receptive'])).toEqual([
      { senseId: 's2', form: 'form-s2', translation: 'tr-s2', levelBefore: 2, levelAfter: 2, raised: [] },
      {
        senseId: 's1',
        form: 'form-s1',
        translation: 'tr-s1',
        levelBefore: 1,
        levelAfter: 2,
        raised: ['written_receptive'],
      },
    ]);
  });

  // Phase 23 (spec D11): a word can move a dimension without moving its badge.
  it('names the live dimensions that rose, even when the badge did not', () => {
    const rows = DIMENSIONS.map((d) => read('s1', 0, d, 1, d === 'written_receptive' || d === 'spoken_receptive' ? 2 : 1));
    expect(progressChanges(rows, ['written_receptive', 'written_productive', 'spelling'])).toEqual([
      {
        senseId: 's1',
        form: 'form-s1',
        translation: 'tr-s1',
        levelBefore: 1,
        levelAfter: 1,
        raised: ['written_receptive'],
      },
    ]);
  });

  it('averages over every live dimension', () => {
    const rows = [
      read('s1', 0, 'written_receptive', 2, 3),
      read('s1', 0, 'written_productive', 1, 1),
      read('s1', 0, 'spelling', 5, 5),
    ];
    expect(progressChanges(rows, ['written_receptive', 'written_productive'])[0]).toMatchObject({
      levelBefore: 2,
      levelAfter: 2,
    });
  });
});

describe('evidenceFor, phase 24 (spec D12)', () => {
  const sense = 's1';
  const piece = (dimension: string, correct: boolean, cap: number | null = null) => ({ dimension, correct, cap });
  const cases: [AnsweredQuestion, Evidence[]][] = [
    [{ senseId: sense, type: 'listen_choice', correct: true }, [piece('spoken_receptive', true)] as Evidence[]],
    [{ senseId: sense, type: 'listen_choice', correct: false }, [piece('spoken_receptive', false)] as Evidence[]],
    [{ senseId: sense, type: 'dictation', verdict: 'exact' }, [piece('spoken_receptive', true), piece('spelling', true)] as Evidence[]],
    [{ senseId: sense, type: 'dictation', verdict: 'near_miss' }, [piece('spoken_receptive', true), piece('spelling', false)] as Evidence[]],
    [{ senseId: sense, type: 'dictation', verdict: 'wrong' }, [piece('spoken_receptive', false)] as Evidence[]],
    [{ senseId: sense, type: 'matching', correct: true }, [piece('written_receptive', true)] as Evidence[]],
    [{ senseId: sense, type: 'matching', correct: false }, [piece('written_receptive', false)] as Evidence[]],
    [
      { senseId: sense, type: 'letter_tiles', verdict: 'exact' },
      [piece('written_receptive', true), piece('written_productive', true, 3)] as Evidence[],
    ],
    [{ senseId: sense, type: 'letter_tiles', verdict: 'wrong' }, [piece('written_productive', false, 3)] as Evidence[]],
  ];
  it.each(cases)('%o', (answer, expected) => {
    expect(evidenceFor(answer)).toEqual(expected);
  });

  it('never credits a written dimension for listening: nothing crosses modalities', () => {
    const dimensions = evidenceFor({ senseId: sense, type: 'dictation', verdict: 'exact' }).map((p) => p.dimension);
    expect(dimensions.filter((d) => d.startsWith('written'))).toEqual([]);
  });
});

describe('phase 25 evidence (spec D10)', () => {
  const s = 's1';
  it('reads aloud as spoken_productive capped at 2, crediting nothing below', () => {
    expect(evidenceFor({ senseId: s, type: 'read_aloud', verdict: 'understood' })).toEqual([
      { dimension: 'spoken_productive', correct: true, cap: READ_ALOUD_MAX_LEVEL },
    ]);
    expect(evidenceFor({ senseId: s, type: 'read_aloud', verdict: 'skipped' })).toEqual([]);
  });

  it('says the translation as spoken_productive, credited down to spoken_receptive', () => {
    expect(evidenceFor({ senseId: s, type: 'say_translation', verdict: 'understood' })).toEqual([
      { dimension: 'spoken_receptive', correct: true, cap: null },
      { dimension: 'spoken_productive', correct: true, cap: null },
    ]);
    expect(evidenceFor({ senseId: s, type: 'say_translation', verdict: 'gave_up' })).toEqual([
      { dimension: 'spoken_productive', correct: false, cap: null },
    ]);
    expect(evidenceFor({ senseId: s, type: 'say_translation', verdict: 'alternative' })).toEqual([]);
    expect(evidenceFor({ senseId: s, type: 'say_translation', verdict: 'skipped' })).toEqual([]);
  });

  it('reads a typed answer to say the translation as a typed card', () => {
    expect(evidenceFor({ senseId: s, type: 'say_translation', verdict: 'exact' })).toEqual(
      evidenceFor({ senseId: s, type: 'typed_translation', verdict: 'exact' }),
    );
    expect(evidenceFor({ senseId: s, type: 'say_translation', verdict: 'wrong' })).toEqual([
      { dimension: 'written_productive', correct: false, cap: null },
    ]);
  });

  it('stops read aloud at level 2, and lifts the cap when say the translation is right the same day', () => {
    const D = '2026-10-07';
    const capped2: Evidence = { dimension: 'spoken_productive', correct: true, cap: 2 };
    const full: Evidence = { dimension: 'spoken_productive', correct: true, cap: null };
    expect(advance(row({ level: 1 }), [capped2], D).level).toBe(2);
    const atTwo = row({ level: 2, lastStepOn: '2026-09-01' });
    expect(advance(atTwo, [capped2], D)).toBe(atTwo);
    expect(advance(atTwo, [capped2, full], D).level).toBe(3);
  });

  it('keeps recognition-format evidence at 3 when a cap of 2 joins it', () => {
    const atThree = row({ level: 3, lastStepOn: '2026-09-01' });
    const D = '2026-10-07';
    expect(advance(atThree, [{ ...right, cap: 3 }, { ...right, cap: 2 }], D)).toBe(atThree);
    expect(advance(row({ level: 2, lastStepOn: '2026-09-01' }), [{ ...right, cap: 3 }, { ...right, cap: 2 }], D).level).toBe(3);
  });
});
