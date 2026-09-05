import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';

import { createTestDb, type TestDb } from '../../tests/support/testDb';
import { createFakeLogger, type FakeLogger } from '../../tests/support/fakes';
import { testRng } from '../../tests/support/testRng';
import type { Db, Tx } from '../db/client';
import { OptionOutOfRange, QuestionDesynced, SessionNotFound } from '../errors';
import { createQuestionRepo } from '../repo/questions';
import { createSessionRepo, type SessionRepo } from '../repo/sessions';
import { createSessionService, type SessionService } from './sessions';

let t: TestDb;
let logger: FakeLogger;
let service: SessionService;

beforeEach(async () => {
  t = await createTestDb();
  logger = createFakeLogger();
  service = createSessionService({
    db: t.db,
    rng: testRng(7),
    logger,
    repos: { session: createSessionRepo, question: createQuestionRepo },
  });
});

afterEach(async () => {
  await t.close();
});

describe('startSession', () => {
  it('creates a user on first sight and returns a ten-question session', async () => {
    const { sessionId, record } = await service.startSession('u1');
    expect(typeof sessionId).toBe('string');
    expect(record.questions).toHaveLength(SESSION_LENGTH);
    expect(record.answers).toEqual([]);
    expect(record.complete).toBe(false);
  });

  it('gives the same learner a second, distinct session', async () => {
    const first = await service.startSession('u1');
    const second = await service.startSession('u1');
    expect(second.sessionId).not.toBe(first.sessionId);
  });
});

describe('submitAnswer', () => {
  it('advances on a fresh answer', async () => {
    const { sessionId, record } = await service.startSession('u1');
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
    const { sessionId, record } = await service.startSession('u1');
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
    const { sessionId, record } = await service.startSession('u1');
    await expect(
      service.submitAnswer(sessionId, record.questions[3].id, 0),
    ).rejects.toBeInstanceOf(QuestionDesynced);
  });

  it('throws OptionOutOfRange for an option index past the last option', async () => {
    const { sessionId, record } = await service.startSession('u1');
    await expect(
      service.submitAnswer(sessionId, record.questions[0].id, 99),
    ).rejects.toBeInstanceOf(OptionOutOfRange);
  });

  it('completes the session on the tenth answer and logs it exactly once', async () => {
    const { sessionId, record } = await service.startSession('u1');

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
      user_id: 'u1',
      score: { correct: SESSION_LENGTH, total: SESSION_LENGTH },
    });
  });

  it('does not log a second time when a completed session is retried', async () => {
    const { sessionId, record } = await service.startSession('u1');
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
    const first = createSessionService({
      db: t.db,
      rng: testRng(7),
      logger: createFakeLogger(),
      repos: { session: createSessionRepo, question: createQuestionRepo },
    });
    const second = createSessionService({
      db: t.db,
      rng: testRng(7),
      logger: createFakeLogger(),
      repos: { session: createSessionRepo, question: createQuestionRepo },
    });

    const a = await first.startSession('u1');
    const b = await second.startSession('u2');

    expect(b.record.questions.map((question) => question.id)).toEqual(
      a.record.questions.map((question) => question.id),
    );
  });
});

describe('repos', () => {
  // This case needs no database: the repository factories are the seam, so a
  // handle that only knows how to run a transaction callback is enough. (The
  // file-level beforeEach still clones one — moving cases like this off Postgres
  // is phase 6's job, not this phase's.)
  function fakeDb(): Db {
    return {
      transaction: (run: (tx: Tx) => Promise<unknown>) => run({} as Tx),
    } as unknown as Db;
  }

  function sessionRepoWith(overrides: Partial<SessionRepo>): SessionRepo {
    const notStubbed = () => {
      throw new Error('this repository method should not have been called');
    };
    return {
      upsertUser: notStubbed,
      insertSession: notStubbed,
      loadSession: notStubbed,
      insertAnswer: notStubbed,
      completeSession: notStubbed,
      ...overrides,
    };
  }

  it('throws SessionNotFound when the repository reports no such session', async () => {
    const service = createSessionService({
      db: fakeDb(),
      rng: testRng(7),
      logger: createFakeLogger(),
      repos: {
        session: () => sessionRepoWith({ loadSession: async () => undefined }),
        question: () => {
          throw new Error('submitAnswer must not load the question pool');
        },
      },
    });

    await expect(
      service.submitAnswer('00000000-0000-0000-0000-000000000000', 'q-window', 0),
    ).rejects.toBeInstanceOf(SessionNotFound);
  });
});
