import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';
import { eq } from 'drizzle-orm';

import { createTestDb, type TestDb } from '../../tests/support/testDb';
import { newSessionRecord } from '../domain/session';
import { sessions } from '../db/schema';
import { createQuestionRepo } from './questions';
import { createSessionRepo } from './sessions';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

// A local deterministic rng. `packages/core`'s seededRng is deliberately
// unreachable — `utils` is absent from both core's index.ts and its exports
// map — and this plan does not change that.
function testRng(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value / 2147483648;
  };
}

/** Creates a session the way the service will, and returns everything about it. */
async function startSession(db: TestDb['db'], userId = 'u1') {
  const sessionRepo = createSessionRepo(db);
  const questionRepo = createQuestionRepo(db);
  const user = await sessionRepo.upsertUser(userId);
  const pool = await questionRepo.loadQuestionPool(user.targetLanguage, user.nativeLanguage, userId);
  const record = newSessionRecord(userId, pool, testRng(7));
  const sessionId = await sessionRepo.insertSession(userId, record.questions);
  return { sessionRepo, sessionId, record };
}

describe('upsertUser', () => {
  it('creates an unknown user with Hebrew/English defaults', async () => {
    const repo = createSessionRepo(t.db);
    expect(await repo.upsertUser('brand-new')).toEqual({
      nativeLanguage: 'he',
      targetLanguage: 'en',
    });
  });

  it('is idempotent for a user that already exists', async () => {
    const repo = createSessionRepo(t.db);
    await repo.upsertUser('twice');
    expect(await repo.upsertUser('twice')).toEqual({
      nativeLanguage: 'he',
      targetLanguage: 'en',
    });
  });
});

describe('insertSession then loadSession', () => {
  it('round-trips the ten questions in presentation order', async () => {
    const { sessionRepo, sessionId, record } = await startSession(t.db);
    const loaded = await sessionRepo.loadSession(sessionId);
    expect(loaded).toBeDefined();
    expect(loaded!.record.questions).toHaveLength(SESSION_LENGTH);
    expect(loaded!.record.questions.map((q) => q.id)).toEqual(record.questions.map((q) => q.id));
  });

  it('round-trips the per-session option shuffle exactly', async () => {
    const { sessionRepo, sessionId, record } = await startSession(t.db);
    const loaded = await sessionRepo.loadSession(sessionId);
    // The shuffled option text and the correct index must survive storage; this
    // is what option_order exists for.
    expect(loaded!.record.questions).toEqual(record.questions);
  });

  it('reports an unstarted session as incomplete with no answers', async () => {
    const { sessionRepo, sessionId } = await startSession(t.db);
    const loaded = await sessionRepo.loadSession(sessionId);
    expect(loaded!.record.answers).toEqual([]);
    expect(loaded!.record.complete).toBe(false);
    expect(loaded!.record.completed_at).toBeNull();
  });

  it('returns undefined for an unknown session id', async () => {
    const repo = createSessionRepo(t.db);
    expect(await repo.loadSession('00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });

  // `sessions.id` is a `uuid` column, so a malformed id would otherwise reach
  // Postgres and raise 22P02 (invalid input syntax for type uuid) rather than
  // simply finding no row. Treat it the same as "not found".
  it('returns undefined for a malformed (non-UUID) session id, without querying the database', async () => {
    const repo = createSessionRepo(t.db);
    expect(await repo.loadSession('not-a-uuid')).toBeUndefined();
  });

  it('exposes an option order parallel to the questions', async () => {
    const { sessionRepo, sessionId } = await startSession(t.db);
    const loaded = await sessionRepo.loadSession(sessionId);
    expect(loaded!.optionOrders).toHaveLength(SESSION_LENGTH);
    for (const order of loaded!.optionOrders) {
      expect([...order].sort()).toEqual([0, 1, 2, 3]);
    }
  });
});

describe('insertAnswer', () => {
  it('reconstitutes answer_string and is_correct from the canonical option', async () => {
    const { sessionRepo, sessionId } = await startSession(t.db);
    const before = await sessionRepo.loadSession(sessionId);
    const question = before!.record.questions[0];
    const displayIndex = question.correct_option;
    const canonical = before!.optionOrders[0][displayIndex];

    await sessionRepo.insertAnswer(sessionId, 0, question.id, canonical);

    const after = await sessionRepo.loadSession(sessionId);
    expect(after!.record.answers).toEqual([
      {
        question_id: question.id,
        is_correct: true,
        answer_string: question.options[displayIndex],
      },
    ]);
  });

  it('records an incorrect answer as incorrect', async () => {
    const { sessionRepo, sessionId } = await startSession(t.db);
    const before = await sessionRepo.loadSession(sessionId);
    const question = before!.record.questions[0];
    const wrongDisplay = (question.correct_option + 1) % question.options.length;
    const canonical = before!.optionOrders[0][wrongDisplay];

    await sessionRepo.insertAnswer(sessionId, 0, question.id, canonical);

    const after = await sessionRepo.loadSession(sessionId);
    expect(after!.record.answers[0].is_correct).toBe(false);
    expect(after!.record.answers[0].answer_string).toBe(question.options[wrongDisplay]);
  });

  it('rejects a second answer at the same position', async () => {
    const { sessionRepo, sessionId } = await startSession(t.db);
    const loaded = await sessionRepo.loadSession(sessionId);
    const question = loaded!.record.questions[0];
    await sessionRepo.insertAnswer(sessionId, 0, question.id, 0);
    await expect(sessionRepo.insertAnswer(sessionId, 0, question.id, 1)).rejects.toThrow();
  });

  it('rejects an answer naming a question not at that position', async () => {
    const { sessionRepo, sessionId } = await startSession(t.db);
    const loaded = await sessionRepo.loadSession(sessionId);
    const notFirst = loaded!.record.questions[1];
    await expect(sessionRepo.insertAnswer(sessionId, 0, notFirst.id, 0)).rejects.toThrow();
  });
});

describe('completeSession', () => {
  it('sets completed_at, which loadSession reports as complete', async () => {
    const { sessionRepo, sessionId } = await startSession(t.db);
    await sessionRepo.completeSession(sessionId);

    const loaded = await sessionRepo.loadSession(sessionId);
    expect(loaded!.record.complete).toBe(true);
    expect(typeof loaded!.record.completed_at).toBe('number');

    const [row] = await t.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row.completedAt).not.toBeNull();
  });

  it('keeps the row after completion — there is no stale sweep', async () => {
    const { sessionRepo, sessionId } = await startSession(t.db);
    await sessionRepo.completeSession(sessionId);
    expect(await sessionRepo.loadSession(sessionId)).toBeDefined();
  });
});
