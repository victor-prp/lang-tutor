import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';

import { createTestDb, type TestDb } from '../../tests/support/testDb';
import { OptionOutOfRange, QuestionDesynced, SessionNotFound } from '../errors';
import { createSessionService } from './sessions';

let t: TestDb;
let service: ReturnType<typeof createSessionService>;

beforeEach(async () => {
  t = await createTestDb();
  service = createSessionService(t.db);
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
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { sessionId, record } = await service.startSession('u1');

    let current = record;
    for (let i = 0; i < SESSION_LENGTH; i++) {
      const question = current.questions[i];
      current = await service.submitAnswer(sessionId, question.id, question.correct_option);
    }

    expect(current.complete).toBe(true);
    expect(current.answers).toHaveLength(SESSION_LENGTH);
    expect(log).toHaveBeenCalledTimes(1);

    const logged = JSON.parse(String(log.mock.calls[0][0]));
    expect(logged.session_id).toBe(sessionId);
    expect(logged.user_id).toBe('u1');
    expect(logged.score).toEqual({ correct: SESSION_LENGTH, total: SESSION_LENGTH });
  });

  it('does not log a second time when a completed session is retried', async () => {
    const { sessionId, record } = await service.startSession('u1');
    let current = record;
    for (let i = 0; i < SESSION_LENGTH; i++) {
      const question = current.questions[i];
      current = await service.submitAnswer(sessionId, question.id, question.correct_option);
    }

    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const last = record.questions[SESSION_LENGTH - 1];
    await service.submitAnswer(sessionId, last.id, last.correct_option);
    expect(log).not.toHaveBeenCalled();
  });
});
