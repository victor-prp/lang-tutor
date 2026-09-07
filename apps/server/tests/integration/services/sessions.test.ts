import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';

import { seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { testRng } from '../../support/testRng';
import {
  OptionOutOfRange,
  QuestionDesynced,
  SessionNotFound,
  UserNotFound,
} from '../../../src/errors';
import { createServerDeps } from '../../../src/composition';
import type { SessionService } from '../../../src/services/sessions';

// The other half of this file's tests is src/services/sessions.test.ts, which
// covers the cases the repository-factory seam makes reachable without Postgres.

let t: TestDb;
let logger: FakeLogger;
let service: SessionService;

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  await seedUser(t.db, 'u_2');
  logger = createFakeLogger();
  service = createServerDeps({ db: t.db, logger, rng: testRng(7) }).sessions;
});

afterEach(async () => {
  await t.close();
});

describe('startSession', () => {
  it('returns a ten-question session for a user who exists', async () => {
    const { sessionId, record } = await service.startSession('u_1');
    expect(typeof sessionId).toBe('string');
    expect(record.questions).toHaveLength(SESSION_LENGTH);
    expect(record.answers).toEqual([]);
    expect(record.complete).toBe(false);
  });

  // The regression test for deleting upsertUser. Before this phase a session
  // for an unknown id silently created the user.
  it('refuses to start a session for a user who does not exist', async () => {
    await expect(service.startSession('u_nobody')).rejects.toBeInstanceOf(UserNotFound);
  });

  it('gives the same learner a second, distinct session', async () => {
    const first = await service.startSession('u_1');
    const second = await service.startSession('u_1');
    expect(second.sessionId).not.toBe(first.sessionId);
  });
});

describe('submitAnswer', () => {
  it('advances on a fresh answer', async () => {
    const { sessionId, record } = await service.startSession('u_1');
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
    const { sessionId, record } = await service.startSession('u_1');
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
    const { sessionId, record } = await service.startSession('u_1');
    await expect(
      service.submitAnswer(sessionId, record.questions[3].id, 0),
    ).rejects.toBeInstanceOf(QuestionDesynced);
  });

  it('throws OptionOutOfRange for an option index past the last option', async () => {
    const { sessionId, record } = await service.startSession('u_1');
    await expect(
      service.submitAnswer(sessionId, record.questions[0].id, 99),
    ).rejects.toBeInstanceOf(OptionOutOfRange);
  });

  it('completes the session on the tenth answer and logs it exactly once', async () => {
    const { sessionId, record } = await service.startSession('u_1');

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
    const { sessionId, record } = await service.startSession('u_1');
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
    const first = createServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) })
      .sessions;
    const second = createServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) })
      .sessions;

    const a = await first.startSession('u_1');
    const b = await second.startSession('u_2');

    expect(b.record.questions.map((question) => question.id)).toEqual(
      a.record.questions.map((question) => question.id),
    );
  });
});
