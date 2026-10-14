import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PgBoss } from 'pg-boss';

import type { SessionService } from '../../../src/services/sessions';
import { createFakeLogger } from '../../support/fakes';
import { startTestBoss, stopTestBoss } from '../../support/jobs';
import { sessionDay } from '../../support/progressRows';
import { insertListSession, type AskedGloss } from '../../support/questions';
import { failReminderUpdates, pinDecidedAt, remindersOf, seedReminder } from '../../support/reminderRows';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

// Phase 52 (spec D6). A finished session marks the latest reminder the learner was sent
// that day, so "practised after a reminder" is a recorded row. The pick itself is
// domain/reminders.test.ts's; this is the proof that it meets the database: the right row
// is written, in the transaction that completes the session.
//
// The learner is in UTC, so their day is the clock's date. decided_at is stamped by the
// database's own clock when a reminder is recorded, so each test moves it to the instant the
// tick would have sent at.

const E = enrollmentOf('u_1');
const DAY = '2026-10-14';
const at = (time: string) => Date.parse(`${DAY}T${time}:00Z`);

let t: TestDb;
let boss: PgBoss;
let clock: number;
let service: SessionService;
let words: AskedGloss[];

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  boss = await startTestBoss(t.db);
  clock = at('12:00');
  service = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(52), now: () => clock, boss }).sessions;
  words = [];
  for (const [lemma, translation] of [['apple', 'תפוח'], ['bread', 'לחם']]) {
    const saved = await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [translation] });
    words.push({ glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation });
  }
});

afterEach(async () => {
  await stopTestBoss(boss);
  await t.close();
});

/** A reminder the tick sent (or decided otherwise) at `time` on DAY, in the slot of that name. */
async function reminder(time: string, outcome: 'sent' | 'skip_target_met' = 'sent', userId = 'u_1', localDay = DAY): Promise<string> {
  const id = await seedReminder(t.db, { userId, localDay, slot: time, outcome });
  await pinDecidedAt(t.db, id, new Date(at(time)));
  return id;
}

/** A list session over the saved words, not yet answered. */
async function open(): Promise<{ sessionId: string; answerAll: () => Promise<void> }> {
  const { sessionId, questions } = await insertListSession(t.db, {
    userId: 'u_1',
    enrollmentId: E,
    asked: words,
    types: words.map(() => 'multiple_choice' as const),
  });
  const answerAll = async () => {
    for (const question of questions) {
      const q = question as unknown as { id: string; correct_option: number };
      await service.submitAnswer('u_1', sessionId, q.id, { option_index: q.correct_option });
    }
  };
  return { sessionId, answerAll };
}

/** A session answered through to its end at `time` on DAY. */
async function finishAt(time: string): Promise<string> {
  clock = at(time);
  const { sessionId, answerAll } = await open();
  await answerAll();
  return sessionId;
}

/** The session each of the learner's reminders was marked for, by slot. */
async function marks(userId = 'u_1'): Promise<Record<string, string | null>> {
  return Object.fromEntries((await remindersOf(t.db, userId)).map((row) => [row.slot, row.sessionId]));
}

describe('a finished session marks its reminder', () => {
  it('marks the reminder sent before it, with the session that followed', async () => {
    await reminder('13:00');
    const sessionId = await finishAt('13:40');
    expect(await marks()).toEqual({ '13:00': sessionId });
  });

  it("marks the day's latest reminder and not an earlier one, whatever was sent before it", async () => {
    await reminder('13:00');
    await reminder('17:00');
    const sessionId = await finishAt('17:10');
    expect(await marks()).toEqual({ '13:00': null, '17:00': sessionId });
  });

  it('marks nothing more for a second session in the same gap', async () => {
    await reminder('13:00');
    const first = await finishAt('13:40');
    await finishAt('14:00');
    expect(await marks()).toEqual({ '13:00': first });
  });

  it('marks a reminder that comes after the first session with the next one, and still nothing earlier', async () => {
    await reminder('13:00');
    await reminder('17:00');
    const first = await finishAt('13:40');
    const second = await finishAt('17:10');
    await finishAt('17:30');
    expect(await marks()).toEqual({ '13:00': first, '17:00': second });
  });

  it('never marks a reminder the tick skipped, even when it is the latest', async () => {
    await reminder('13:00', 'sent');
    await reminder('17:00', 'skip_target_met');
    const sessionId = await finishAt('17:10');
    expect(await marks()).toEqual({ '13:00': sessionId, '17:00': null });
  });

  it('marks nothing for a reminder that was only skipped', async () => {
    await reminder('13:00', 'skip_target_met');
    await finishAt('13:40');
    expect(await marks()).toEqual({ '13:00': null });
  });

  it('does not mark a reminder decided after the session ended', async () => {
    await reminder('17:00');
    await finishAt('13:40');
    expect(await marks()).toEqual({ '17:00': null });
  });

  it("leaves another day's reminder, and another learner's, alone", async () => {
    await seedUser(t.db, 'u_2');
    await reminder('13:00', 'sent', 'u_1', '2026-10-13');
    await reminder('13:00', 'sent', 'u_2');
    await finishAt('13:40');
    expect(await marks('u_1')).toEqual({ '13:00': null });
    expect(await marks('u_2')).toEqual({ '13:00': null });
  });

  it('is not needed to finish: a learner who was never reminded completes as before', async () => {
    const sessionId = await finishAt('13:40');
    expect(await service.getSession('u_1', sessionId)).toMatchObject({ status: 'completed', complete: true });
    expect(await sessionDay(t.db, sessionId)).toBe(DAY);
    expect(await remindersOf(t.db, 'u_1')).toEqual([]);
  });

  it('is part of the completion: when the mark cannot be written, the session does not finish', async () => {
    await reminder('13:00');
    clock = at('13:40');
    const { sessionId, answerAll } = await open();
    await failReminderUpdates(t.db);
    await expect(answerAll()).rejects.toThrow();
    expect(await service.getSession('u_1', sessionId)).toMatchObject({ status: 'ready', complete: false });
    expect(await sessionDay(t.db, sessionId)).toBeNull();
    expect(await marks()).toEqual({ '13:00': null });
  });
});
