import { describe, expect, it } from '@jest/globals';

import { applyTargetSession, capHalves, isRecallCard, nextPracticeIn, practiceDays, targetSessionWrite } from './targetSkills';
import type { HoldingTarget, TargetAnswer, TargetSkillRow, TimedTargetAnswer } from './targetSkills';

describe('capHalves', () => {
  it.each([
    [1, 20], [2, 16], [3, 10], [4, 8], [5, 7], [6, 6], [9, 6], [10, 5], [14, 5], [20, 4],
    [21, 3], [27, 3], [28, 2], [100, 2], [0, 20], [-1, 20],
  ])('days left %i caps at %i', (days, cap) => {
    expect(capHalves(days)).toBe(cap);
  });
});

describe('practice days', () => {
  it('lists the table days descending', () => {
    expect(practiceDays()).toEqual([27, 20, 14, 9, 5, 4, 3, 2, 1]);
  });
  it.each([[19, 5], [9, 4], [1, null]])('nextPracticeIn(%i) is %s', (days, next) => {
    expect(nextPracticeIn(days)).toBe(next);
  });
});

describe('isRecallCard', () => {
  it('separates producing cards from choosing ones', () => {
    for (const t of ['typed_meaning', 'typed_translation', 'cloze_typed', 'sentence_translation', 'dictation', 'say_translation'] as const) {
      expect(isRecallCard(t)).toBe(true);
    }
    for (const t of ['multiple_choice', 'reverse_choice', 'cloze_choice', 'letter_tiles', 'listen_choice', 'matching'] as const) {
      expect(isRecallCard(t)).toBe(false);
    }
  });
});

describe('applyTargetSession', () => {
  const recall = (o: Partial<TargetAnswer> = {}): TargetAnswer => ({
    type: 'typed_meaning', verdict: 'exact', glossId: 'g1', helped: false, ...o,
  });
  const choice = (o: Partial<TargetAnswer> = {}): TargetAnswer => ({
    type: 'multiple_choice', correct: true, glossId: 'g1', helped: false, ...o,
  });
  const row = (halves: number, dimension: TargetSkillRow['dimension'] = 'written_receptive', glossId = 'g1'): TargetSkillRow => ({
    targetId: 't1', glossId, dimension, halves, sessionId: null, day: null,
  });
  const run = (answers: TargetAnswer[], before: TargetSkillRow[] = [], cap = 20, glossIds = ['g1']) =>
    applyTargetSession({ targetId: 't1', sessionId: 's1', day: '2026-10-16', capHalves: cap, glossIds: new Set(glossIds), before, answers });

  it('a right recall on a skill at 0 gives 4, with an event', () => {
    const { rows, events } = run([recall()]);
    expect(rows).toEqual([{ ...row(4), sessionId: 's1', day: '2026-10-16' }]);
    expect(events).toEqual([{ targetId: 't1', glossId: 'g1', dimension: 'written_receptive', sessionId: 's1', before: 0, after: 4, why: 'recall' }]);
  });
  it('recognition only gives 2', () => {
    const { rows, events } = run([choice()]);
    expect(rows[0].halves).toBe(2);
    expect(events[0].why).toBe('recognition');
  });
  it('a miss and a right recall in one session is -4, floored at 0', () => {
    const { rows, events } = run([recall(), recall({ verdict: 'wrong' })], [row(6)]);
    expect(rows[0].halves).toBe(2);
    expect(events[0].why).toBe('miss');
    expect(run([recall({ verdict: 'wrong' }), recall()], [row(3)]).rows[0].halves).toBe(0);
  });
  it('a miss at 0 changes nothing', () => {
    expect(run([recall({ verdict: 'wrong' })])).toEqual({ rows: [], events: [] });
  });
  it('three right recalls count once', () => {
    expect(run([recall(), recall(), recall()]).rows[0].halves).toBe(4);
  });
  it('a gain stops at the cap', () => {
    expect(run([recall()], [row(4)], 5).rows[0].halves).toBe(5);
  });
  it('a value above the cap stays', () => {
    expect(run([recall()], [row(10)], 4)).toEqual({ rows: [], events: [] });
  });
  it('intro, read aloud and meet change nothing', () => {
    expect(run([recall({ intro: true }), { type: 'read_aloud', verdict: 'exact', glossId: 'g1', helped: false }, { type: 'meet', glossId: 'g1', helped: false }])).toEqual({ rows: [], events: [] });
  });
  it('a helped answer changes nothing', () => {
    expect(run([recall({ helped: true }), recall({ verdict: 'wrong', helped: true })], [row(6)])).toEqual({ rows: [], events: [] });
  });
  it('a dictation near miss is a miss for spelling and a right recall for spoken receptive', () => {
    const { rows } = run([{ type: 'dictation', verdict: 'near_miss', glossId: 'g1', helped: false }], [row(6, 'spelling')]);
    expect(rows.map((r) => [r.dimension, r.halves]).sort()).toEqual([['spelling', 2], ['spoken_receptive', 4]]);
  });
  it('ignores answers about glosses outside the target', () => {
    expect(run([recall({ glossId: 'other' })])).toEqual({ rows: [], events: [] });
  });
  it('leaves an untouched skill alone', () => {
    const { rows, events } = run([recall()], [row(8, 'spelling')]);
    expect(rows).toHaveLength(1);
    expect(events).toHaveLength(1);
  });
});

describe('targetSessionWrite', () => {
  const DAY = '2026-10-16';
  const at = (minute: number) => `2026-10-16T09:${String(minute).padStart(2, '0')}:00.000000Z`;
  const typed = (glossId: string, minute: number, o: Partial<TimedTargetAnswer> = {}): TimedTargetAnswer => ({
    type: 'typed_meaning', verdict: 'exact', glossId, helped: false, answeredAt: at(minute), ...o,
  });
  const target = (id: string, dueOn: string, words: [glossId: string, addedMinute: number][]): HoldingTarget => ({
    id, dueOn, kind: 'homework', words: words.map(([glossId, minute]) => ({ glossId, addedAt: at(minute) })),
  });
  const write = (targets: HoldingTarget[], answers: TimedTargetAnswer[], before: TargetSkillRow[] = []) =>
    targetSessionWrite({ sessionId: 's1', day: DAY, targets, before, answers });

  it("moves each target's skills against its own cap, and starts the words it asked", () => {
    const soon = target('t-soon', '2026-10-17', [['g1', 0]]); // one day left: cap 20
    const far = target('t-far', '2026-11-30', [['g1', 0]]); // past the table: cap 2
    const { rows, events, started } = write([soon, far], [typed('g1', 5)]);
    expect(rows.map((row) => [row.targetId, row.halves])).toEqual([['t-soon', 4], ['t-far', 2]]);
    expect(events.map((event) => [event.targetId, event.before, event.after, event.why])).toEqual([
      ['t-soon', 0, 4, 'recall'],
      ['t-far', 0, 2, 'recall'],
    ]);
    expect(started).toEqual([
      { targetId: 't-soon', glossIds: ['g1'] },
      { targetId: 't-far', glossIds: ['g1'] },
    ]);
  });

  it('counts an answer given at or after the word joined the target, and none before', () => {
    const exam = target('t1', '2026-10-17', [['g1', 5], ['g2', 5]]);
    const { rows, started } = write([exam], [typed('g1', 4), typed('g2', 5)]);
    expect(rows.map((row) => row.glossId)).toEqual(['g2']);
    expect(started).toEqual([{ targetId: 't1', glossIds: ['g2'] }]);
  });

  it('compares instants to the microsecond', () => {
    const exam = { id: 't1', dueOn: '2026-10-17', kind: 'exam' as const, words: [{ glossId: 'g1', addedAt: '2026-10-16T09:00:00.000501Z' }] };
    const early = typed('g1', 0, { answeredAt: '2026-10-16T09:00:00.000500Z' });
    expect(write([exam], [early])).toEqual({ rows: [], events: [], started: [] });
  });

  it('starts a word an intro card or a helped answer asked, and moves none of its skills', () => {
    const exam = target('t1', '2026-10-17', [['g1', 0], ['g2', 0]]);
    const { rows, started } = write([exam], [typed('g1', 1, { intro: true }), typed('g2', 2, { helped: true, verdict: 'wrong' })]);
    expect(rows).toEqual([]);
    expect(started).toEqual([{ targetId: 't1', glossIds: ['g1', 'g2'] }]);
  });

  it('caps a gain at the top on the due date itself', () => {
    const due = target('t1', DAY, [['g1', 0]]);
    const before: TargetSkillRow[] = [{ targetId: 't1', glossId: 'g1', dimension: 'written_receptive', halves: 18, sessionId: null, day: null }];
    expect(write([due], [typed('g1', 1)], before).rows.map((row) => row.halves)).toEqual([20]);
  });

  it("reads each target's own rows only", () => {
    const a = target('t-a', '2026-10-17', [['g1', 0]]);
    const b = target('t-b', '2026-10-17', [['g1', 0]]);
    const before: TargetSkillRow[] = [{ targetId: 't-a', glossId: 'g1', dimension: 'written_receptive', halves: 8, sessionId: null, day: null }];
    expect(write([a, b], [typed('g1', 1)], before).rows.map((row) => [row.targetId, row.halves])).toEqual([['t-a', 12], ['t-b', 4]]);
  });

  it('writes nothing for a target none of whose words the session asked', () => {
    expect(write([target('t1', '2026-10-17', [['g9', 0]])], [typed('g1', 1)])).toEqual({ rows: [], events: [], started: [] });
  });
});
