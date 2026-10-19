import { describe, expect, it } from '@jest/globals';
import { readinessFromMemory, review, skillChance } from '@lang-tutor/core/domain';

import type { MemoryRow } from './memoryUpdate';
import { readinessSessionWrite } from './readinessWrite';
import type { HoldingTarget, TimedTargetAnswer } from './targetSkills';

const DAY = '2026-10-17';
const DUE = '2026-10-22';
const at = (minute: number) => `2026-10-17T09:${String(minute).padStart(2, '0')}:00.000000Z`;
const typed = (glossId: string, minute: number, o: Partial<TimedTargetAnswer> = {}): TimedTargetAnswer => ({
  type: 'typed_translation', verdict: 'exact', glossId, helped: false, answeredAt: at(minute), ...o,
});
const target = (id: string, kind: 'homework' | 'exam', words: [string, number][], dueOn = DUE): HoldingTarget => ({
  id, dueOn, kind, words: words.map(([glossId, minute]) => ({ glossId, addedAt: at(minute) })),
});
const write = (targets: HoldingTarget[], answers: TimedTargetAnswer[], memory: MemoryRow[] = []) =>
  readinessSessionWrite({ sessionId: 's1', day: DAY, targets, before: [], memory, answers });
const memoryRow = (glossId: string, dimension: MemoryRow['dimension']): MemoryRow => ({
  glossId, dimension, reachedOn: null, state: review(null, 3, '2026-10-10'),
});

describe('readinessSessionWrite', () => {
  it('starts a skill with no row from the main memory (R1): first_right, before read from it', () => {
    const memory = memoryRow('g1', 'written_productive');
    const { rows, events } = write([target('t1', 'homework', [['g1', 0]])], [typed('g1', 5)], [memory]);
    const only = events.filter((event) => event.dimension === 'written_productive');
    expect(only).toHaveLength(1);
    expect(only[0].why).toBe('first_right');
    expect(only[0].before).toBeCloseTo(skillChance(readinessFromMemory(memory.state), DUE), 10);
    expect(only[0].day).toBe(DAY);
    expect(rows.find((row) => row.dimension === 'written_productive')?.sessionId).toBe('s1');
  });

  it('starts from nothing when neither a row nor a memory exists', () => {
    const { events } = write([target('t1', 'homework', [['g1', 0]])], [typed('g1', 5)]);
    expect(events.every((event) => event.before === 0 && event.why === 'first_right')).toBe(true);
  });

  it('does not count an answer given before the word joined the target', () => {
    const { rows, events } = write([target('t1', 'homework', [['g1', 5], ['g2', 5]])], [typed('g1', 4), typed('g2', 5)]);
    expect(new Set(rows.map((row) => row.glossId))).toEqual(new Set(['g2']));
    expect(new Set(events.map((event) => event.glossId))).toEqual(new Set(['g2']));
  });

  it('writes nothing for uncounted skills', () => {
    const say = typed('g1', 5, { type: 'say_translation', verdict: 'understood' });
    // With a typed translation beside it, the exam's write is not empty: it writes its counted
    // skills, and speaking is not one of them.
    const exam = write([target('t1', 'exam', [['g1', 0]])], [say, typed('g1', 6)]);
    expect(exam.rows.length).toBeGreaterThan(0);
    expect(exam.rows.map((row) => row.dimension)).not.toContain('spoken_productive');
    const hw = write([target('t1', 'homework', [['g1', 0]])], [typed('g1', 5)]);
    expect(hw.rows.map((row) => row.dimension)).not.toContain('written_receptive');
    expect(hw.rows.length).toBeGreaterThan(0);
  });

  it('writes nothing on or after the due date (D3.7)', () => {
    const { rows, events } = write([target('t1', 'homework', [['g1', 0]], DAY)], [typed('g1', 5)]);
    expect(rows).toEqual([]);
    expect(events).toEqual([]);
  });

  it('holds the exam row on a first miss and not the homework one', () => {
    const miss = typed('g1', 5, { verdict: 'wrong' });
    const { rows } = write([target('hw', 'homework', [['g1', 0]]), target('ex', 'exam', [['g1', 0]])], [miss]);
    const held = (id: string) => rows.filter((row) => row.targetId === id && row.dimension === 'written_productive').map((row) => row.row.held);
    expect(held('ex')).toEqual([true]);
    expect(held('hw')).toEqual([false]);
  });

  it('writes one event per applied answer and none for an ignored one', () => {
    const answers = [typed('g1', 5), typed('g1', 6, { verdict: 'wrong' }), typed('g1', 7, { verdict: 'wrong' }), typed('g1', 8), typed('g1', 9), typed('g1', 10)];
    const { rows, events } = write([target('t1', 'homework', [['g1', 0]])], answers);
    const wp = events.filter((event) => event.dimension === 'written_productive').map((event) => event.why);
    // right, miss, (second miss ignored), bonus, bonus, (third bonus ignored)
    expect(wp).toEqual(['first_right', 'miss', 'bonus', 'bonus']);
    expect(rows.filter((row) => row.dimension === 'written_productive')).toHaveLength(1);
  });
});
