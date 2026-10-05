import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';

import type { PgBoss } from 'pg-boss';

import { PREPARE_SESSION, type PrepareSessionPayload } from '../../../src/domain/jobs';
import { startTestBoss, stopTestBoss } from '../../support/jobs';
import { enrollmentOf, seedEnrollment, seedUser } from '../../support/seedUser';
import { seedSavedSenses } from '../../support/vocabularyRows';
import { createTestDb, type TestDb } from '../../support/testDb';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { testRng } from '../../support/testRng';
import {
  EnrollmentNotFound,
  NoSavedWords,
  OptionOutOfRange,
  QuestionDesynced,
  SessionNotFound,
  SessionNotReady,
  SessionNotSkippable,
  SessionOpen,
} from '../../../src/errors';
import { createTestServerDeps } from '../../support/serverDeps';
import type { SessionService } from '../../../src/services/sessions';

// The other half of this file's tests is src/services/sessions.test.ts, which
// covers the cases the repository-factory seam makes reachable without Postgres.

let t: TestDb;
let logger: FakeLogger;
let service: SessionService;

let boss: PgBoss;

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  await seedUser(t.db, 'u_2');
  logger = createFakeLogger();
  boss = await startTestBoss(t.db);
  service = createTestServerDeps({ db: t.db, logger, rng: testRng(7), boss }).sessions;
});

afterEach(async () => {
  await stopTestBoss(boss);
  await t.close();
});

/** The seed session every learner starts with, read back whole. */
async function startSeed(enrollmentId: string) {
  const { sessionId } = await service.createNextSession(enrollmentId);
  return { sessionId, record: await service.getSession(sessionId) };
}

describe('createNextSession', () => {
  const E = enrollmentOf('u_1');

  it('starts with a ready ten-question seed session', async () => {
    const created = await service.createNextSession(E);
    expect(created).toMatchObject({ status: 'ready', source: 'seed' });
    const record = await service.getSession(created.sessionId);
    expect(record.questions).toHaveLength(SESSION_LENGTH);
    expect(record.answers).toEqual([]);
  });

  // The regression test for deleting upsertUser. Before phase 8 a session for
  // an unknown id silently created the user; it must not create an enrollment.
  it('refuses an enrollment that does not exist', async () => {
    await expect(service.createNextSession('e_nobody')).rejects.toBeInstanceOf(EnrollmentNotFound);
  });

  it('refuses a second session while one is open', async () => {
    await service.createNextSession(E);
    await expect(service.createNextSession(E)).rejects.toBeInstanceOf(SessionOpen);
  });

  // Review Focus 1: a double tap.
  it('lets exactly one of two concurrent creates through', async () => {
    const results = await Promise.allSettled([service.createNextSession(E), service.createNextSession(E)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(SessionOpen);
  });

  it('after the seed, asks for saved words when the list is empty', async () => {
    const { sessionId } = await service.createNextSession(E);
    await service.skipSession(sessionId);
    await expect(service.createNextSession(E)).rejects.toBeInstanceOf(NoSavedWords);
  });

  it('after the seed, prepares a list session from at most ten saved senses', async () => {
    const { sessionId: seed } = await service.createNextSession(E);
    await service.skipSession(seed);
    const saved = await seedSavedSenses(t.db, {
      enrollmentId: E,
      lemma: 'tome',
      translations: ['ספר', 'כרך', 'חיבור', 'מחברת', 'דף', 'עמוד', 'פרק', 'שער', 'כותר', 'ספרון', 'קובץ', 'גליון'],
    });

    const created = await service.createNextSession(E);
    expect(created).toMatchObject({ status: 'preparing', source: 'list' });

    const jobs = await boss.findJobs<PrepareSessionPayload>(PREPARE_SESSION);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data.session_id).toBe(created.sessionId);
    expect(jobs[0].data.picks).toHaveLength(SESSION_LENGTH);
    expect(jobs[0].data.picks.every((p) => saved.senseIds.includes(p.sense_id))).toBe(true);
  });
});

describe('currentSession', () => {
  const E = enrollmentOf('u_1');

  it('is empty before any session, and points at the seed', async () => {
    expect(await service.currentSession(E)).toEqual({ current: null, nextSource: 'seed', savedCount: 0 });
  });

  it('shows the open session with its progress', async () => {
    const { sessionId, record } = await startSeed(E);
    await service.submitAnswer(sessionId, record.questions[0].id, 0);
    expect(await service.currentSession(E)).toEqual({
      current: { id: sessionId, status: 'ready', source: 'seed', answered: 1, total: SESSION_LENGTH },
      nextSource: 'list',
      savedCount: 0,
    });
  });

  it('shows nothing once the session is skipped', async () => {
    const { sessionId } = await service.createNextSession(E);
    await service.skipSession(sessionId);
    expect((await service.currentSession(E)).current).toBeNull();
  });

  // Review Focus 5: another enrollment's session is not this one's.
  it("keeps one enrollment's session out of another's", async () => {
    await seedEnrollment(t.db, { id: 'e_ru', userId: 'u_1', targetLanguage: 'ru' });
    await service.createNextSession(E);
    expect(await service.currentSession('e_ru')).toEqual({ current: null, nextSource: 'seed', savedCount: 0 });
  });

  it('refuses an enrollment that does not exist', async () => {
    await expect(service.currentSession('e_nobody')).rejects.toBeInstanceOf(EnrollmentNotFound);
  });
});

describe('skipSession', () => {
  const E = enrollmentOf('u_1');

  it('skips a ready session, and a second skip is a no-op', async () => {
    const { sessionId } = await service.createNextSession(E);
    await service.skipSession(sessionId);
    await service.skipSession(sessionId);
    expect((await service.getSession(sessionId)).status).toBe('skipped');
  });

  it('refuses a completed session', async () => {
    const { sessionId, record } = await startSeed(E);
    for (const question of record.questions) await service.submitAnswer(sessionId, question.id, 0);
    await expect(service.skipSession(sessionId)).rejects.toBeInstanceOf(SessionNotSkippable);
  });

  it('refuses an unknown session', async () => {
    await expect(service.skipSession('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(SessionNotFound);
  });

  it('a skipped session takes no more answers', async () => {
    const { sessionId, record } = await startSeed(E);
    await service.skipSession(sessionId);
    await expect(service.submitAnswer(sessionId, record.questions[0].id, 0)).rejects.toBeInstanceOf(SessionNotReady);
  });
});

describe('getSession', () => {
  it('refuses an unknown or malformed id', async () => {
    await expect(service.getSession('nope')).rejects.toBeInstanceOf(SessionNotFound);
  });
});

describe('submitAnswer', () => {
  it('advances on a fresh answer', async () => {
    const { sessionId, record } = await startSeed(enrollmentOf('u_1'));
    const question = record.questions[0];
    const after = await service.submitAnswer(sessionId, question.id, question.correct_option);
    expect(after.answers).toHaveLength(1);
    expect(after.answers[0]).toEqual({
      question_id: question.id,
      is_correct: true,
      answer_string: question.options[question.correct_option],
    });
    expect(after.complete).toBe(false);
  });

  it('replays a retried answer without double-counting it', async () => {
    const { sessionId, record } = await startSeed(enrollmentOf('u_1'));
    const question = record.questions[0];
    await service.submitAnswer(sessionId, question.id, question.correct_option);
    const retry = await service.submitAnswer(sessionId, question.id, question.correct_option);
    expect(retry.answers).toHaveLength(1);
  });

  it('throws SessionNotFound for an unknown session', async () => {
    await expect(
      service.submitAnswer('00000000-0000-0000-0000-000000000000', 'q-window', 0),
    ).rejects.toBeInstanceOf(SessionNotFound);
  });

  it('throws QuestionDesynced for a question that is not current', async () => {
    const { sessionId, record } = await startSeed(enrollmentOf('u_1'));
    await expect(
      service.submitAnswer(sessionId, record.questions[3].id, 0),
    ).rejects.toBeInstanceOf(QuestionDesynced);
  });

  it('throws OptionOutOfRange for an option index past the last option', async () => {
    const { sessionId, record } = await startSeed(enrollmentOf('u_1'));
    await expect(
      service.submitAnswer(sessionId, record.questions[0].id, 99),
    ).rejects.toBeInstanceOf(OptionOutOfRange);
  });

  it('completes the session on the tenth answer and logs it exactly once', async () => {
    const { sessionId, record } = await startSeed(enrollmentOf('u_1'));

    let current = record;
    for (let i = 0; i < SESSION_LENGTH; i++) {
      const question = current.questions[i];
      current = await service.submitAnswer(sessionId, question.id, question.correct_option);
    }

    expect(current.complete).toBe(true);
    expect(current.answers).toHaveLength(SESSION_LENGTH);
    expect(logger.events).toHaveLength(1);
    expect(logger.events[0]).toMatchObject({
      session_id: sessionId,
      user_id: 'u_1',
      score: { correct: SESSION_LENGTH, total: SESSION_LENGTH },
    });
  });

  it('does not log a second time when a completed session is retried', async () => {
    const { sessionId, record } = await startSeed(enrollmentOf('u_1'));
    let current = record;
    for (let i = 0; i < SESSION_LENGTH; i++) {
      const question = current.questions[i];
      current = await service.submitAnswer(sessionId, question.id, question.correct_option);
    }
    expect(logger.events).toHaveLength(1);

    const last = record.questions[SESSION_LENGTH - 1];
    await service.submitAnswer(sessionId, last.id, last.correct_option);
    expect(logger.events).toHaveLength(1);
  });
});

describe('rng', () => {
  it('draws the same ten questions for two services sharing a seed', async () => {
    const first = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) })
      .sessions;
    const second = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) })
      .sessions;

    const a = await first.getSession((await first.createNextSession(enrollmentOf('u_1'))).sessionId);
    const b = await second.getSession((await second.createNextSession(enrollmentOf('u_2'))).sessionId);

    expect(b.questions.map((question) => question.id)).toEqual(
      a.questions.map((question) => question.id),
    );
  });
});
