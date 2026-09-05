import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';
import { eq } from 'drizzle-orm';

import { createTestDb, type TestDb } from '../../tests/support/testDb';
import { testRng } from '../../tests/support/testRng';
import { withTx } from '../../tests/support/withTx';
import type { Tx } from '../db/client';
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

/** Creates a session the way the service does — inside the caller's transaction. */
async function startSession(tx: Tx, userId = 'u1') {
  const sessionRepo = createSessionRepo(tx);
  const questionRepo = createQuestionRepo(tx);
  const user = await sessionRepo.upsertUser(userId);
  const pool = await questionRepo.loadQuestionPool(user.targetLanguage, user.nativeLanguage, userId);
  const record = newSessionRecord(userId, pool, testRng(7));
  const sessionId = await sessionRepo.insertSession(userId, record.questions);
  return { sessionRepo, sessionId, record };
}

describe('upsertUser', () => {
  it('creates an unknown user with Hebrew/English defaults', async () => {
    await withTx(t.db, async (tx) => {
      const repo = createSessionRepo(tx);
      expect(await repo.upsertUser('brand-new')).toEqual({
        nativeLanguage: 'he',
        targetLanguage: 'en',
      });
    });
  });

  it('is idempotent for a user that already exists', async () => {
    await withTx(t.db, async (tx) => {
      const repo = createSessionRepo(tx);
      await repo.upsertUser('twice');
      expect(await repo.upsertUser('twice')).toEqual({
        nativeLanguage: 'he',
        targetLanguage: 'en',
      });
    });
  });
});

describe('insertSession then loadSession', () => {
  it('round-trips the ten questions in presentation order', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId, record } = await startSession(tx);
      const loaded = await sessionRepo.loadSession(sessionId);
      expect(loaded).toBeDefined();
      expect(loaded!.record.questions).toHaveLength(SESSION_LENGTH);
      expect(loaded!.record.questions.map((q) => q.id)).toEqual(record.questions.map((q) => q.id));
    });
  });

  it('round-trips the per-session option shuffle exactly', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId, record } = await startSession(tx);
      const loaded = await sessionRepo.loadSession(sessionId);
      // The shuffled option text and the correct index must survive storage; this
      // is what option_order exists for.
      expect(loaded!.record.questions).toEqual(record.questions);
    });
  });

  it('reports an unstarted session as incomplete with no answers', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId } = await startSession(tx);
      const loaded = await sessionRepo.loadSession(sessionId);
      expect(loaded!.record.answers).toEqual([]);
      expect(loaded!.record.complete).toBe(false);
      expect(loaded!.record.completed_at).toBeNull();
    });
  });

  it('returns undefined for an unknown session id', async () => {
    await withTx(t.db, async (tx) => {
      const repo = createSessionRepo(tx);
      expect(await repo.loadSession('00000000-0000-0000-0000-000000000000')).toBeUndefined();
    });
  });

  // `sessions.id` is a `uuid` column, so a malformed id would otherwise reach
  // Postgres and raise 22P02 (invalid input syntax for type uuid) rather than
  // simply finding no row. Treat it the same as "not found".
  it('returns undefined for a malformed (non-UUID) session id, without querying the database', async () => {
    await withTx(t.db, async (tx) => {
      const repo = createSessionRepo(tx);
      expect(await repo.loadSession('not-a-uuid')).toBeUndefined();
    });
  });

  it('exposes an option order parallel to the questions', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId } = await startSession(tx);
      const loaded = await sessionRepo.loadSession(sessionId);
      expect(loaded!.optionOrders).toHaveLength(SESSION_LENGTH);
      for (const order of loaded!.optionOrders) {
        expect([...order].sort()).toEqual([0, 1, 2, 3]);
      }
    });
  });
});

describe('insertAnswer', () => {
  it('reconstitutes answer_string and is_correct from the canonical option', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId } = await startSession(tx);
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
  });

  it('records an incorrect answer as incorrect', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId } = await startSession(tx);
      const before = await sessionRepo.loadSession(sessionId);
      const question = before!.record.questions[0];
      const wrongDisplay = (question.correct_option + 1) % question.options.length;
      const canonical = before!.optionOrders[0][wrongDisplay];

      await sessionRepo.insertAnswer(sessionId, 0, question.id, canonical);

      const after = await sessionRepo.loadSession(sessionId);
      expect(after!.record.answers[0].is_correct).toBe(false);
      expect(after!.record.answers[0].answer_string).toBe(question.options[wrongDisplay]);
    });
  });

  // The constraint violation aborts the transaction, and nothing runs in it
  // afterwards: Postgres answers the eventual COMMIT with a rollback, which is
  // the correct outcome for a test that asserts only the rejection.
  it('rejects a second answer at the same position', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId } = await startSession(tx);
      const loaded = await sessionRepo.loadSession(sessionId);
      const question = loaded!.record.questions[0];
      await sessionRepo.insertAnswer(sessionId, 0, question.id, 0);
      await expect(sessionRepo.insertAnswer(sessionId, 0, question.id, 1)).rejects.toThrow();
    });
  });

  it('rejects an answer naming a question not at that position', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId } = await startSession(tx);
      const loaded = await sessionRepo.loadSession(sessionId);
      const notFirst = loaded!.record.questions[1];
      await expect(sessionRepo.insertAnswer(sessionId, 0, notFirst.id, 0)).rejects.toThrow();
    });
  });
});

describe('completeSession', () => {
  it('sets completed_at, which loadSession reports as complete', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId } = await startSession(tx);
      await sessionRepo.completeSession(sessionId);

      const loaded = await sessionRepo.loadSession(sessionId);
      expect(loaded!.record.complete).toBe(true);
      expect(typeof loaded!.record.completed_at).toBe('number');

      // Read through `tx`, not `t.db`: a pool connection would not see this
      // transaction's uncommitted write, and the assertion would fail for a
      // reason that has nothing to do with completeSession.
      const [row] = await tx.select().from(sessions).where(eq(sessions.id, sessionId));
      expect(row.completedAt).not.toBeNull();
    });
  });

  it('keeps the row after completion — there is no stale sweep', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId } = await startSession(tx);
      await sessionRepo.completeSession(sessionId);
      expect(await sessionRepo.loadSession(sessionId)).toBeDefined();
    });
  });
});
