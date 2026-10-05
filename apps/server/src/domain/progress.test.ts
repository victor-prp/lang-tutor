import { describe, expect, it } from '@jest/globals';
import { DIMENSIONS, type Dimension } from '@lang-tutor/core/domain';

import {
  advance,
  daysBetween,
  evaluateSession,
  evidenceFor,
  progressChanges,
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
const right: Evidence = { dimension: 'written_receptive', correct: true, capped: false };
const wrong: Evidence = { ...right, correct: false };
const cappedRight: Evidence = { ...right, capped: true };
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
      { senseId: 's2', form: 'form-s2', translation: 'tr-s2', levelBefore: 2, levelAfter: 2 },
      { senseId: 's1', form: 'form-s1', translation: 'tr-s1', levelBefore: 1, levelAfter: 2 },
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
