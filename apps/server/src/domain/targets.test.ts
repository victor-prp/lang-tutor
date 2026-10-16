import { describe, expect, it } from '@jest/globals';
import { retrievability, type Dimension, type MemoryState } from '@lang-tutor/core/domain';

import { activeOn, openOn, readinessOf, recallOnDue, type Readiness, type TargetKind } from './targets';

const DUE = '2026-10-20';
const REVIEWED = '2026-10-10';

/** A state last reviewed on lastDay. Reviewed 10 days before DUE, stability 10 gives R = 0.9 on DUE
 *  (R is 0.9 once the days since the review equal the stability: the model's definition), and a
 *  higher stability gives a higher R. */
function memory(stability: number, lastDay = REVIEWED): MemoryState {
  return { stability, difficulty: 5, lastDay, reps: 3, lapses: 0, params: 'fsrs6-default' };
}

const row = (dimension: Dimension, stability: number, lastDay = REVIEWED) => ({
  dimension,
  state: memory(stability, lastDay),
});

describe('recallOnDue', () => {
  it('is null for a gloss with no memory row: not met', () => {
    expect(recallOnDue([], ['written_receptive', 'spelling'], true, DUE)).toBeNull();
  });

  it('counts a live skill with no row as 0', () => {
    expect(recallOnDue([row('written_receptive', 30)], ['written_receptive', 'spelling'], true, DUE)).toBe(0);
  });

  it('is 1 when the date is on or before every last review', () => {
    const rows = [row('written_receptive', 5, DUE), row('spelling', 5, '2026-10-25')];
    expect(recallOnDue(rows, ['written_receptive', 'spelling'], true, DUE)).toBe(1);
  });

  it('takes the weakest live skill, whatever the order of the rows', () => {
    const rows = [row('written_receptive', 100), row('spelling', 10)];
    const live: Dimension[] = ['written_receptive', 'spelling'];
    const recall = recallOnDue(rows, live, true, DUE);
    expect(recall).toBeCloseTo(0.9, 10);
    expect(recall).toBe(retrievability(memory(10), DUE));
    expect(retrievability(memory(100), DUE)).toBeGreaterThan(0.9);
    expect(recallOnDue([...rows].reverse(), live, true, DUE)).toBe(recall);
  });

  it('reads only the live skills: a weak row in a skill that is off does not count', () => {
    const rows = [row('written_receptive', 30), row('spoken_receptive', 1)];
    expect(recallOnDue(rows, ['written_receptive'], true, DUE)).toBe(retrievability(memory(30), DUE));
  });

  it('is 0, not null, when the only rows are in skills that are off: the gloss was met', () => {
    expect(recallOnDue([row('spoken_receptive', 30)], ['written_receptive'], true, DUE)).toBe(0);
  });

  describe('spoken_productive', () => {
    const live: Dimension[] = ['written_receptive', 'spoken_productive'];

    it('is left out for a gloss that cannot be spoken: a skill it can never have does not hold it at 0', () => {
      expect(recallOnDue([row('written_receptive', 30)], live, false, DUE)).toBe(retrievability(memory(30), DUE));
    });

    it('counts for a gloss that can be spoken: 0 while it has no row', () => {
      expect(recallOnDue([row('written_receptive', 30)], live, true, DUE)).toBe(0);
    });

    it('counts its row only when the gloss can be spoken', () => {
      const rows = [row('written_receptive', 30), row('spoken_productive', 3)];
      expect(recallOnDue(rows, live, true, DUE)).toBe(retrievability(memory(3), DUE));
      expect(recallOnDue(rows, live, false, DUE)).toBe(retrievability(memory(30), DUE));
    });
  });
});

describe('readinessOf', () => {
  it.each<[TargetKind, number | null, Readiness]>([
    ['exam', 0.9, 'ready'],
    ['exam', 0.8999, 'almost'],
    ['exam', 0.7, 'almost'],
    ['exam', 0.6999, 'on_the_way'],
    ['exam', null, 'not_started'],
    ['homework', 0.8, 'ready'],
    ['homework', 0.7999, 'almost'],
    ['homework', 0.6, 'almost'],
    ['homework', 0.5999, 'on_the_way'],
    ['homework', null, 'not_started'],
  ])('reads %s at %s as %s', (kind, recall, readiness) => {
    expect(readinessOf(kind, recall)).toBe(readiness);
  });

  it('tells a word met and wholly forgotten from one not met', () => {
    expect(readinessOf('exam', 0)).toBe('on_the_way');
    expect(readinessOf('homework', 0)).toBe('on_the_way');
  });

  it('reads a sure thing as ready', () => {
    expect(readinessOf('exam', 1)).toBe('ready');
    expect(readinessOf('homework', 1)).toBe('ready');
  });
});

// Phase 57 (spec D10, ruling P2).
describe('activeOn and openOn', () => {
  const target = (dueOn: string, endedAt: Date | null = null) => ({ dueOn, endedAt });

  it.each<[string, boolean, boolean]>([
    ['2026-10-19', true, true],
    ['2026-10-20', true, false],
    ['2026-10-21', false, false],
  ])('on %s, a target due on DUE is active %s and open to change %s', (today, active, open) => {
    expect(activeOn(target(DUE), today)).toBe(active);
    expect(openOn(target(DUE), today)).toBe(open);
  });

  it('is neither once ended early', () => {
    expect(activeOn(target(DUE, new Date('2026-10-12T09:00:00Z')), '2026-10-13')).toBe(false);
    expect(openOn(target(DUE, new Date('2026-10-12T09:00:00Z')), '2026-10-13')).toBe(false);
  });
});
