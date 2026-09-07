import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';
import { eq } from 'drizzle-orm';

import { seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { withTx } from '../../support/withTx';
import type { Tx } from '../../../src/db/client';
import { newSessionRecord } from '../../../src/domain/session';
import { sessions } from '../../../src/db/schema';
import { createQuestionRepo } from '../../../src/repo/questions';
import { createSessionRepo } from '../../../src/repo/sessions';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
});

afterEach(async () => {
  await t.close();
});

/** Creates a session the way the service does — inside the caller's transaction. */
async function startSession(tx: Tx, userId = 'u_1') {
  const sessionRepo = createSessionRepo(tx);
  const questionRepo = createQuestionRepo(tx);
  const pool = await questionRepo.loadQuestionPool('en', 'he', userId);
  const record = newSessionRecord(userId, pool, testRng(7));
  const sessionId = await sessionRepo.insertSession(userId, record.questions);
  return { sessionRepo, sessionId, record };
}

describe('insertSession then loadSession', () => {
  it('round-trips the ten questions in presentation order', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId, record } = await startSession(tx);
      const loaded = await sessionRepo.loadSession(sessionId);
      expect(loaded).toBeDefined();
      expect(loaded!.questions).toHaveLength(SESSION_LENGTH);
      expect(loaded!.questions.map((q) => q.id)).toEqual(record.questions.map((q) => q.id));
    });
  });

  it('round-trips the per-session option shuffle exactly', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId, record } = await startSession(tx);
      const loaded = await sessionRepo.loadSession(sessionId);
      // The shuffled option text and the correct index must survive storage; this
      // is what option_order exists for.
      expect(loaded!.questions).toEqual(record.questions);
    });
  });

  it('reports an unstarted session as incomplete with no answers', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId } = await startSession(tx);
      const loaded = await sessionRepo.loadSession(sessionId);
      expect(loaded!.answers).toEqual([]);
      expect(loaded!.complete).toBe(false);
      expect(loaded!.completed_at).toBeNull();
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
});

describe('insertAnswer', () => {
  it('reconstitutes answer_string and is_correct from the canonical option', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId } = await startSession(tx);
      const before = await sessionRepo.loadSession(sessionId);
      const question = before!.questions[0];
      const displayIndex = question.correct_option;

      await sessionRepo.insertAnswer(sessionId, 0, question.id, displayIndex);

      const after = await sessionRepo.loadSession(sessionId);
      expect(after!.answers).toEqual([
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
      const question = before!.questions[0];
      const wrongDisplay = (question.correct_option + 1) % question.options.length;

      await sessionRepo.insertAnswer(sessionId, 0, question.id, wrongDisplay);

      const after = await sessionRepo.loadSession(sessionId);
      expect(after!.answers[0].is_correct).toBe(false);
      expect(after!.answers[0].answer_string).toBe(question.options[wrongDisplay]);
    });
  });

  // The constraint violation aborts the transaction, and nothing runs in it
  // afterwards: Postgres answers the eventual COMMIT with a rollback, which is
  // the correct outcome for a test that asserts only the rejection.
  it('rejects a second answer at the same position', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId } = await startSession(tx);
      const loaded = await sessionRepo.loadSession(sessionId);
      const question = loaded!.questions[0];
      await sessionRepo.insertAnswer(sessionId, 0, question.id, 0);
      await expect(sessionRepo.insertAnswer(sessionId, 0, question.id, 1)).rejects.toThrow();
    });
  });

  it('rejects an answer naming a question not at that position', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId } = await startSession(tx);
      const loaded = await sessionRepo.loadSession(sessionId);
      const notFirst = loaded!.questions[1];
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
      expect(loaded!.complete).toBe(true);
      expect(typeof loaded!.completed_at).toBe('number');

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
