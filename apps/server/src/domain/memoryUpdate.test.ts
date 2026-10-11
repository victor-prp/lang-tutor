import { describe, expect, it } from '@jest/globals';
import { review } from '@lang-tutor/core/domain';

import { applySession, type MemoryRow } from './memoryUpdate';

const choice = (glossId: string, correct: boolean) => ({ glossId, type: 'multiple_choice' as const, correct });
const find = (rows: MemoryRow[], glossId: string, dimension: string) =>
  rows.find((row) => row.glossId === glossId && row.dimension === dimension);

describe('applySession', () => {
  it('starts a row with no state at its first review', () => {
    const out = applySession([], [choice('g1', true)], '2026-03-04');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ glossId: 'g1', dimension: 'written_receptive', state: review(null, 3, '2026-03-04') });
  });

  it('applies one answer\'s pieces to each dimension it grades', () => {
    const out = applySession([], [{ glossId: 'g1', type: 'typed_translation', verdict: 'near_miss' }], '2026-03-04');
    expect(out.map((r) => r.dimension).sort()).toEqual(['spelling', 'written_productive', 'written_receptive']);
    expect(find(out, 'g1', 'spelling')!.state.lapses).toBe(1);
  });

  it('uses the long-term rule for the first review of a day and t = 0 for later ones', () => {
    const first = review(null, 3, '2026-03-01');
    const prior: MemoryRow[] = [{ glossId: 'g1', dimension: 'written_receptive', state: first }];
    const out = applySession(prior, [choice('g1', true), choice('g1', true)], '2026-03-05');
    const afterFirst = review(first, 3, '2026-03-05');
    expect(afterFirst.lastDay).toBe('2026-03-05');
    expect(out).toEqual([
      { glossId: 'g1', dimension: 'written_receptive', state: review(afterFirst, 3, '2026-03-05') },
    ]);
  });

  it('treats a row last reviewed earlier today as a t = 0 review', () => {
    const today = review(null, 3, '2026-03-05');
    const out = applySession(
      [{ glossId: 'g1', dimension: 'written_receptive', state: today }],
      [choice('g1', false)],
      '2026-03-05',
    );
    expect(out[0].state).toEqual(review(today, 1, '2026-03-05'));
  });

  it('returns only the rows it touched and leaves the input alone', () => {
    const other: MemoryRow = { glossId: 'g2', dimension: 'spelling', state: review(null, 3, '2026-03-01') };
    const out = applySession([other], [choice('g1', true)], '2026-03-05');
    expect(out.map((r) => r.glossId)).toEqual(['g1']);
  });

  it('grades nothing for a card that evidences nothing', () => {
    expect(applySession([], [{ glossId: 'g1', type: 'read_aloud', verdict: 'understood' }], '2026-03-05')).toEqual([]);
  });
});
