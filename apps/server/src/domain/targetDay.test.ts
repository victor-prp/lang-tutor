import { describe, expect, it } from '@jest/globals';

import type { Dimension } from '@lang-tutor/core/domain';

import { targetDay, type TargetWordInput } from './targetDay';
import type { TargetSkillRow } from './targetSkills';

const DIMS: Dimension[] = ['written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling'];

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const D0 = '2026-11-01';

const word = (i: number, over: Partial<TargetWordInput> = {}): TargetWordInput => ({
  glossId: `g${String(i).padStart(2, '0')}`,
  addedOn: D0,
  startedOn: null,
  live: DIMS,
  ...over,
});
const words = (n: number, over: (i: number) => Partial<TargetWordInput> = () => ({})) =>
  Array.from({ length: n }, (_, i) => word(i, over(i)));
const rows = (glossIds: string[], halves: number, dims: readonly Dimension[] = DIMS): TargetSkillRow[] =>
  glossIds.flatMap((glossId) =>
    dims.map((dimension) => ({ targetId: 't', glossId, dimension, halves, sessionId: null, day: null })),
  );
const base = { createdOn: D0, skills: [] as TargetSkillRow[], rightToday: new Set<string>(), answeredToday: false };

describe('targetDay', () => {
  it('homework due tomorrow, created today: every word is toStart at cap 20', () => {
    const day = targetDay({ ...base, today: D0, dueOn: addDays(D0, 1), words: words(6) });
    expect(day.capHalves).toBe(20);
    expect(day.planned).toBe(6);
    expect(day.state).toBe('owed');
    expect(day.words.every((w) => w.toStart && w.state === 'owed')).toBe(true);
  });

  it('an exam 20 days out with 20 words plans 10 on day 0 and all 20 on day 6', () => {
    const due = addDays(D0, 20);
    const d0 = targetDay({ ...base, today: D0, dueOn: due, words: words(20) });
    expect(d0.planned).toBe(10);
    const d6 = targetDay({ ...base, today: addDays(D0, 6), dueOn: due, words: words(20) });
    expect(d6.planned).toBe(20);
  });

  const started = (n: number) => words(20, (i) => (i < n ? { startedOn: D0 } : {}));
  const startedIds = Array.from({ length: 10 }, (_, i) => `g${String(i).padStart(2, '0')}`);

  it('day 2 after day 0 and 1 were finished owes nothing: rest, next practice in 4', () => {
    const day = targetDay({
      ...base,
      today: addDays(D0, 2),
      dueOn: addDays(D0, 20),
      words: started(10),
      skills: rows(startedIds, 4),
    });
    expect(day.state).toBe('rest');
    expect(day.nextPracticeIn).toBe(4);
  });

  it('day 1 owes the next-day checks of day 0 words', () => {
    const day = targetDay({
      ...base,
      today: addDays(D0, 1),
      dueOn: addDays(D0, 20),
      words: started(10),
      skills: rows(startedIds, 4),
    });
    expect(day.state).toBe('owed');
    const w = day.words.find((x) => x.glossId === 'g00')!;
    expect(w.owed).toEqual([]);
    expect(w.checks).toEqual(DIMS);
    const answered = targetDay({
      ...base,
      today: addDays(D0, 1),
      dueOn: addDays(D0, 20),
      words: started(10),
      skills: rows(startedIds, 4),
      rightToday: new Set(startedIds.flatMap((g) => DIMS.map((d) => `${g}|${d}`))),
      answeredToday: true,
    });
    expect(answered.state).toBe('done');
  });

  it("Victor's case: 20 words, 2 started 3 days ago at a 20-day exam is owed with 8 toStart", () => {
    const day = targetDay({
      ...base,
      today: addDays(D0, 3),
      dueOn: addDays(D0, 20),
      words: started(2),
      skills: rows(['g00', 'g01'], 2),
    });
    expect(day.state).toBe('owed');
    expect(day.words.filter((w) => w.toStart)).toHaveLength(8);
    expect(day.words[0].owed).toEqual(DIMS);
  });

  it('a word started early today is extra and the target stays done', () => {
    const day = targetDay({
      ...base,
      today: D0,
      dueOn: addDays(D0, 20),
      words: words(20, (i) => (i < 10 ? { startedOn: D0 } : i === 15 ? { startedOn: D0 } : {})),
      skills: [...rows(startedIds, 4), ...rows(['g15'], 4)],
      answeredToday: true,
    });
    expect(day.words.find((w) => w.glossId === 'g15')!.state).toBe('extra');
    expect(day.extra).toBe(1);
    expect(day.state).toBe('done');
  });

  it('the same word the next day owes the cap like the rest', () => {
    const day = targetDay({
      ...base,
      today: addDays(D0, 1),
      dueOn: addDays(D0, 20),
      words: words(20, (i) => (i < 10 || i === 15 ? { startedOn: D0 } : {})),
      skills: [...rows(startedIds, 4), ...rows(['g15'], 2)],
    });
    const w = day.words.find((x) => x.glossId === 'g15')!;
    expect(w.state).toBe('owed');
    expect(w.owed).toEqual(DIMS);
  });

  it('a word added after halfway is planned at once', () => {
    const day = targetDay({
      ...base,
      today: addDays(D0, 12),
      dueOn: addDays(D0, 20),
      words: [...words(1, () => ({ startedOn: D0 })), word(7, { addedOn: addDays(D0, 12) })],
    });
    const w = day.words.find((x) => x.glossId === 'g07')!;
    expect(w.toStart).toBe(true);
  });

  it('a date moved earlier keeps values and owes more', () => {
    const skills = rows(['g00'], 4);
    const ws = [word(0, { startedOn: D0 })];
    const far = targetDay({ ...base, today: addDays(D0, 2), dueOn: addDays(D0, 20), words: ws, skills });
    const near = targetDay({ ...base, today: addDays(D0, 2), dueOn: addDays(D0, 5), words: ws, skills });
    expect(far.words[0].owed).toEqual([]);
    expect(near.words[0].owed).toEqual(DIMS);
    expect(near.words[0].skills.every((s) => s.halves === 4)).toBe(true);
  });

  it('an unspeakable word readiness ignores speaking', () => {
    const live = DIMS.filter((d) => !String(d).includes('spoken'));
    const w = word(0, { live, startedOn: D0 });
    const day = targetDay({ ...base, today: addDays(D0, 2), dueOn: addDays(D0, 5), words: [w], skills: rows(['g00'], 20, live) });
    expect(day.words[0].readinessPct).toBe(100);
    expect(day.readinessPct).toBe(100);
    expect(day.readyCount).toBe(1);
  });

  it('due_today on the date with no checks owed', () => {
    const day = targetDay({
      ...base,
      today: addDays(D0, 5),
      dueOn: addDays(D0, 5),
      words: [word(0, { startedOn: addDays(D0, 4) })],
      skills: rows(['g00'], 20),
    });
    expect(day.state).toBe('due_today');
    expect(day.words[0].checks).toEqual([]);
  });
});
