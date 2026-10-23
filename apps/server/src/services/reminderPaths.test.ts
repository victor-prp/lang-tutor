import type { Enrollment, MyWordsToday, TargetList, TargetSummary } from '@lang-tutor/core/api';
import { describe, expect, it } from '@jest/globals';

import { createReminderPaths, type PathReads } from './reminderPaths';

// Phase 75 (spec D1). A learner's day as a reminder reads it: each course's targets as home's
// cards read them, then its My words.

const enrollment = (id: string, language: string): Enrollment => ({
  id,
  user_id: 'u_1',
  source_language: 'he',
  target_language: language,
  created_at: '2026-10-01T00:00:00.000Z',
});

const summary = (over: Partial<TargetSummary> & Pick<TargetSummary, 'id'>): TargetSummary => ({
  kind: 'homework',
  due_on: '2026-10-25',
  created_on: '2026-10-20',
  days_left: 1,
  word_count: 9,
  ready_count: 3,
  readiness_pct: 40,
  readiness_start_pct: 35,
  practice_more_little: false,
  word_readiness: [],
  today: {
    state: 'owed',
    done: 0,
    planned: 4,
    extra: 0,
    next_practice_in: null,
    sessions_budget: null,
    sessions_offer: 2,
    sessions_done: 0,
    ended_early: false,
    minutes: 6,
  },
  session: null,
  ...over,
});

const today = (over: Partial<MyWordsToday> = {}): MyWordsToday => ({
  goal: 3,
  sessions_done: 1,
  new_words: 0,
  moved_up: 0,
  minutes: 9,
  ...over,
});

function reads(over: Partial<PathReads> = {}): PathReads & { actors: string[] } {
  const actors: string[] = [];
  const lists: Record<string, TargetList> = {
    e_it: { today: '2026-10-24', targets: [summary({ id: 't_hw' })] },
    e_en: { today: '2026-10-24', targets: [] },
  };
  return {
    actors,
    enrollments: async () => [enrollment('e_it', 'it'), enrollment('e_en', 'en')],
    targets: async (actor, enrollmentId) => {
      actors.push(actor);
      return lists[enrollmentId];
    },
    myWordsDay: async (actor, enrollmentId) => {
      actors.push(actor);
      return enrollmentId === 'e_it'
        ? { today: today(), waiting: 12, saved: 40 }
        : { today: today({ goal: null, sessions_done: 0 }), waiting: 0, saved: 0 };
    },
    ...over,
  };
}

describe('reminder paths', () => {
  it("lists each course's targets, then its My words, in the order of the learner's enrollments", async () => {
    const paths = await createReminderPaths(reads())('u_1');

    expect(paths).toEqual([
      {
        kind: 'homework',
        enrollmentId: 'e_it',
        language: 'it',
        targetId: 't_hw',
        daysLeft: 1,
        state: 'owed',
        wordCount: 9,
        readyCount: 3,
        readinessPct: 40,
        sessionsOffer: 2,
        sessionsDone: 0,
        minutes: 6,
      },
      { kind: 'my_words', enrollmentId: 'e_it', language: 'it', goal: 3, sessionsDone: 1, waiting: 12, saved: 40 },
      { kind: 'my_words', enrollmentId: 'e_en', language: 'en', goal: null, sessionsDone: 0, waiting: 0, saved: 0 },
    ]);
  });

  it('reads as the learner, over their own enrollments', async () => {
    const fake = reads();
    const asked: string[] = [];
    await createReminderPaths({ ...fake, enrollments: async (userId) => (asked.push(userId), fake.enrollments(userId)) })('u_1');

    expect(asked).toEqual(['u_1']);
    expect(new Set(fake.actors)).toEqual(new Set(['u_1']));
  });

  it('fails as a whole when one read fails', async () => {
    const failing = reads({
      myWordsDay: async () => {
        throw new Error('read failed');
      },
    });

    await expect(createReminderPaths(failing)('u_1')).rejects.toThrow('read failed');
  });
});
