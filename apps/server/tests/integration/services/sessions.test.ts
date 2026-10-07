import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';

import type { PgBoss } from 'pg-boss';

import { PREPARE_SESSION, type PrepareSessionPayload } from '../../../src/domain/jobs';
import { startTestBoss, stopTestBoss } from '../../support/jobs';
import { enrollmentOf, seedEnrollment, seedUser } from '../../support/seedUser';
import { seedSavedSenses } from '../../support/vocabularyRows';
import { createTestDb, type TestDb } from '../../support/testDb';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { asChoice } from '../../support/questions';
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
import type { SessionRecord } from '../../../src/domain/session';
import type { SessionService } from '../../../src/services/sessions';
import type { VocabularyService } from '../../../src/services/vocabulary';
import {
  failInsertsInto,
  readProgress,
  readSnapshot,
  saveSessionSenses,
  sessionDay,
} from '../../support/progressRows';

// The other half of this file's tests is src/services/sessions.test.ts, which
// covers the cases the repository-factory seam makes reachable without Postgres.

let t: TestDb;
let logger: FakeLogger;
let service: SessionService;
let vocabulary: VocabularyService;

let boss: PgBoss;

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  await seedUser(t.db, 'u_2');
  logger = createFakeLogger();
  boss = await startTestBoss(t.db);
  const deps = createTestServerDeps({ db: t.db, logger, rng: testRng(7), boss });
  service = deps.sessions;
  vocabulary = deps.vocabulary;
});

afterEach(async () => {
  await stopTestBoss(boss);
  await t.close();
});

/** The seed session every learner starts with, read back whole. */
async function startSeed(enrollmentId: string) {
  const { sessionId } = await service.createNextSession(enrollmentId, { listening: false });
  return { sessionId, record: await service.getSession(sessionId) };
}

describe('createNextSession', () => {
  const E = enrollmentOf('u_1');

  it('starts with a ready ten-question seed session', async () => {
    const created = await service.createNextSession(E, { listening: false });
    expect(created).toMatchObject({ status: 'ready', source: 'seed' });
    const record = await service.getSession(created.sessionId);
    expect(record.questions).toHaveLength(SESSION_LENGTH);
    expect(record.answers).toEqual([]);
  });

  // The regression test for deleting upsertUser. Before phase 8 a session for
  // an unknown id silently created the user; it must not create an enrollment.
  it('refuses an enrollment that does not exist', async () => {
    await expect(service.createNextSession('e_nobody', { listening: false })).rejects.toBeInstanceOf(EnrollmentNotFound);
  });

  it('refuses a second session while one is open', async () => {
    await service.createNextSession(E, { listening: false });
    await expect(service.createNextSession(E, { listening: false })).rejects.toBeInstanceOf(SessionOpen);
  });

  // Review Focus 1: a double tap.
  it('lets exactly one of two concurrent creates through', async () => {
    const results = await Promise.allSettled([service.createNextSession(E, { listening: false }), service.createNextSession(E, { listening: false })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(SessionOpen);
  });

  it('after the seed, asks for saved words when the list is empty', async () => {
    const { sessionId } = await service.createNextSession(E, { listening: false });
    await service.skipSession(sessionId);
    await expect(service.createNextSession(E, { listening: false })).rejects.toBeInstanceOf(NoSavedWords);
  });

  it('after the seed, prepares a list session from at most ten saved senses', async () => {
    const { sessionId: seed } = await service.createNextSession(E, { listening: false });
    await service.skipSession(seed);
    const saved = await seedSavedSenses(t.db, {
      enrollmentId: E,
      lemma: 'tome',
      translations: ['ספר', 'כרך', 'חיבור', 'מחברת', 'דף', 'עמוד', 'פרק', 'שער', 'כותר', 'ספרון', 'קובץ', 'גליון'],
    });

    const created = await service.createNextSession(E, { listening: false });
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
    await service.submitAnswer(sessionId, record.questions[0].id, { option_index: 0 });
    expect(await service.currentSession(E)).toEqual({
      current: { id: sessionId, status: 'ready', source: 'seed', answered: 1, total: SESSION_LENGTH },
      nextSource: 'list',
      savedCount: 0,
    });
  });

  it('shows nothing once the session is skipped', async () => {
    const { sessionId } = await service.createNextSession(E, { listening: false });
    await service.skipSession(sessionId);
    expect((await service.currentSession(E)).current).toBeNull();
  });

  // Review Focus 5: another enrollment's session is not this one's.
  it("keeps one enrollment's session out of another's", async () => {
    await seedEnrollment(t.db, { id: 'e_ru', userId: 'u_1', targetLanguage: 'ru' });
    await service.createNextSession(E, { listening: false });
    expect(await service.currentSession('e_ru')).toEqual({ current: null, nextSource: 'seed', savedCount: 0 });
  });

  it('refuses an enrollment that does not exist', async () => {
    await expect(service.currentSession('e_nobody')).rejects.toBeInstanceOf(EnrollmentNotFound);
  });
});

describe('skipSession', () => {
  const E = enrollmentOf('u_1');

  it('skips a ready session, and a second skip is a no-op', async () => {
    const { sessionId } = await service.createNextSession(E, { listening: false });
    await service.skipSession(sessionId);
    await service.skipSession(sessionId);
    expect((await service.getSession(sessionId)).status).toBe('skipped');
  });

  it('refuses a completed session', async () => {
    const { sessionId, record } = await startSeed(E);
    for (const question of record.questions) await service.submitAnswer(sessionId, question.id, { option_index: 0 });
    await expect(service.skipSession(sessionId)).rejects.toBeInstanceOf(SessionNotSkippable);
  });

  it('refuses an unknown session', async () => {
    await expect(service.skipSession('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(SessionNotFound);
  });

  it('a skipped session takes no more answers', async () => {
    const { sessionId, record } = await startSeed(E);
    await service.skipSession(sessionId);
    await expect(service.submitAnswer(sessionId, record.questions[0].id, { option_index: 0 })).rejects.toBeInstanceOf(SessionNotReady);
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
    const question = asChoice(record.questions[0]);
    const after = await service.submitAnswer(sessionId, question.id, { option_index: question.correct_option });
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
    const question = asChoice(record.questions[0]);
    await service.submitAnswer(sessionId, question.id, { option_index: question.correct_option });
    const retry = await service.submitAnswer(sessionId, question.id, { option_index: question.correct_option });
    expect(retry.answers).toHaveLength(1);
  });

  it('throws SessionNotFound for an unknown session', async () => {
    await expect(
      service.submitAnswer('00000000-0000-0000-0000-000000000000', 'q-window', { option_index: 0 }),
    ).rejects.toBeInstanceOf(SessionNotFound);
  });

  it('throws QuestionDesynced for a question that is not current', async () => {
    const { sessionId, record } = await startSeed(enrollmentOf('u_1'));
    await expect(
      service.submitAnswer(sessionId, record.questions[3].id, { option_index: 0 }),
    ).rejects.toBeInstanceOf(QuestionDesynced);
  });

  it('throws OptionOutOfRange for an option index past the last option', async () => {
    const { sessionId, record } = await startSeed(enrollmentOf('u_1'));
    await expect(
      service.submitAnswer(sessionId, record.questions[0].id, { option_index: 99 }),
    ).rejects.toBeInstanceOf(OptionOutOfRange);
  });

  it('completes the session on the tenth answer and logs it exactly once', async () => {
    const { sessionId, record } = await startSeed(enrollmentOf('u_1'));

    let current = record;
    for (let i = 0; i < SESSION_LENGTH; i++) {
      const question = asChoice(current.questions[i]);
      current = await service.submitAnswer(sessionId, question.id, { option_index: question.correct_option });
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
      const question = asChoice(current.questions[i]);
      current = await service.submitAnswer(sessionId, question.id, { option_index: question.correct_option });
    }
    expect(logger.events).toHaveLength(1);

    const last = asChoice(record.questions[SESSION_LENGTH - 1]);
    await service.submitAnswer(sessionId, last.id, { option_index: last.correct_option });
    expect(logger.events).toHaveLength(1);
  });
});

describe('rng', () => {
  it('draws the same ten questions for two services sharing a seed', async () => {
    const first = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) })
      .sessions;
    const second = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) })
      .sessions;

    const a = await first.getSession((await first.createNextSession(enrollmentOf('u_1'), { listening: false })).sessionId);
    const b = await second.getSession((await second.createNextSession(enrollmentOf('u_2'), { listening: false })).sessionId);

    expect(b.questions.map((question) => question.id)).toEqual(
      a.questions.map((question) => question.id),
    );
  });
});

describe('progress (phase 20)', () => {
  const E = enrollmentOf('u_1');

  /** The seed, with the senses of its first three questions saved. */
  async function seedWithSavedSenses() {
    const { sessionId, record } = await startSeed(E);
    const saved = await saveSessionSenses(t.db, { sessionId, enrollmentId: E, positions: [0, 1, 2] });
    return { sessionId, record, saved };
  }

  async function answer(sessionId: string, question: SessionRecord['questions'][number], right: boolean) {
    const q = asChoice(question);
    return service.submitAnswer(sessionId, q.id, {
      option_index: right ? q.correct_option : (q.correct_option + 1) % q.options.length,
    });
  }

  async function answerAll(sessionId: string, record: SessionRecord, wrongAt: number[] = []) {
    let last;
    for (const [i, q] of record.questions.entries()) last = await answer(sessionId, q, !wrongAt.includes(i));
    return last!;
  }

  const receptive = (rows: Awaited<ReturnType<typeof readProgress>>, senseId: string) =>
    rows.find((row) => row.senseId === senseId && row.dimension === 'written_receptive');

  it('completing a session lifts each saved sense answered right, and records what it did', async () => {
    const { sessionId, record, saved } = await seedWithSavedSenses();
    const result = await answerAll(sessionId, record, [1]);
    const day = await sessionDay(t.db, sessionId);
    const rows = await readProgress(t.db, E);

    expect(receptive(rows, saved[0])).toMatchObject({ level: 2, lastStepOn: day, lastWrongOn: null });
    expect(receptive(rows, saved[1])).toMatchObject({ level: 1, lastStepOn: null, lastWrongOn: day });
    expect(receptive(rows, saved[2])).toMatchObject({ level: 2, lastStepOn: day });
    expect(rows.filter((row) => row.dimension !== 'written_receptive').every((row) => row.level === 1)).toBe(true);
    expect(await readSnapshot(t.db, sessionId)).toHaveLength(15);
    // Phase 23: recognition alone moves one of three live dimensions, so the
    // badge, (2, 1, 1), still reads 1; `raised` says what did move.
    expect(result.progress.map((p) => [p.senseId, p.levelBefore, p.levelAfter, p.raised])).toEqual([
      [saved[0], 1, 1, ['written_receptive']],
      [saved[1], 1, 1, []],
      [saved[2], 1, 1, ['written_receptive']],
    ]);
  });

  it('a skip counts the answers given before it', async () => {
    const { sessionId, record, saved } = await seedWithSavedSenses();
    await answer(sessionId, record.questions[0], true);
    await service.skipSession(sessionId);
    const rows = await readProgress(t.db, E);
    expect(receptive(rows, saved[0])).toMatchObject({ level: 2 });
    expect(rows.filter((row) => row.senseId !== saved[0]).every((row) => row.level === 1)).toBe(true);
    expect(await readSnapshot(t.db, sessionId)).toHaveLength(5);
  });

  it('a skip with no answers writes nothing', async () => {
    const { sessionId } = await seedWithSavedSenses();
    await service.skipSession(sessionId);
    expect((await readProgress(t.db, E)).every((row) => row.level === 1 && row.lastWrongOn === null)).toBe(true);
    expect(await readSnapshot(t.db, sessionId)).toEqual([]);
  });

  it('answers about senses that are not saved write nothing', async () => {
    const { sessionId, record } = await startSeed(E);
    const result = await answerAll(sessionId, record);
    expect(await readProgress(t.db, E)).toEqual([]);
    expect(await readSnapshot(t.db, sessionId)).toEqual([]);
    expect(result.progress).toEqual([]);
  });

  // Review Focus 2: a sense unsaved while its session is open.
  it('a sense unsaved mid-session is left out when the session completes', async () => {
    const { sessionId, record, saved } = await seedWithSavedSenses();
    await answer(sessionId, record.questions[0], true);
    await vocabulary.unsave(E, saved[0]);
    for (const q of record.questions.slice(1)) await answer(sessionId, q, true);

    const finished = await service.getSession(sessionId);
    expect(finished.status).toBe('completed');
    const rows = await readProgress(t.db, E);
    expect(rows.some((row) => row.senseId === saved[0])).toBe(false);
    expect(receptive(rows, saved[1])).toMatchObject({ level: 2 });
    expect(finished.progress.map((p) => p.senseId)).toEqual([saved[1], saved[2]]);
  });

  it('completion and its progress are one transaction', async () => {
    const { sessionId, record } = await seedWithSavedSenses();
    for (const q of record.questions.slice(0, 9)) await answer(sessionId, q, true);
    await failInsertsInto(t.db, 'session_progress');
    await expect(answer(sessionId, record.questions[9], true)).rejects.toThrow();
    const after = await service.getSession(sessionId);
    expect(after).toMatchObject({ status: 'ready', complete: false });
    expect(after.answers).toHaveLength(9);
    expect((await readProgress(t.db, E)).every((row) => row.level === 1)).toBe(true);
  });

  it('a skip and its progress are one transaction', async () => {
    const { sessionId, record } = await seedWithSavedSenses();
    await answer(sessionId, record.questions[0], true);
    await failInsertsInto(t.db, 'session_progress');
    await expect(service.skipSession(sessionId)).rejects.toThrow();
    expect((await service.getSession(sessionId)).status).toBe('ready');
    expect((await readProgress(t.db, E)).every((row) => row.level === 1)).toBe(true);
  });

  it('getSession answers a completed session with the change it made', async () => {
    const { sessionId, record, saved } = await seedWithSavedSenses();
    const finished = await answerAll(sessionId, record);
    expect(finished.progress.map((p) => p.senseId)).toEqual(saved);
    expect((await service.getSession(sessionId)).progress).toEqual(finished.progress);
  });
});
