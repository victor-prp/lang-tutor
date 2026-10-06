import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';
import { eq } from 'drizzle-orm';

import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { asChoice } from '../../support/questions';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';
import { withTx } from '../../support/withTx';
import type { Tx } from '../../../src/db/client';
import { newSessionRecord } from '../../../src/domain/session';
import { answers, sessionQuestions, sessions } from '../../../src/db/schema';
import { SessionOpen } from '../../../src/errors';
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
  const pool = await questionRepo.loadQuestionPool('en', 'he');
  const record = newSessionRecord(userId, pool, testRng(7));
  const sessionId = await sessionRepo.insertSession(userId, enrollmentOf(userId), record.questions);
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
      const question = asChoice(before!.questions[0]);
      const displayIndex = question.correct_option;

      await sessionRepo.insertAnswer(sessionId, 0, question.id, { displayIndex });

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
      const question = asChoice(before!.questions[0]);
      const wrongDisplay = (question.correct_option + 1) % question.options.length;

      await sessionRepo.insertAnswer(sessionId, 0, question.id, { displayIndex: wrongDisplay });

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
      await sessionRepo.insertAnswer(sessionId, 0, question.id, { displayIndex: 0 });
      await expect(sessionRepo.insertAnswer(sessionId, 0, question.id, { displayIndex: 1 })).rejects.toThrow();
    });
  });

  it('rejects an answer naming a question not at that position', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId } = await startSession(tx);
      const loaded = await sessionRepo.loadSession(sessionId);
      const notFirst = loaded!.questions[1];
      await expect(sessionRepo.insertAnswer(sessionId, 0, notFirst.id, { displayIndex: 0 })).rejects.toThrow();
    });
  });
});

describe('phase 23: typed answers', () => {
  /** A list session holding one typed question, the way prepare-session writes it. */
  async function typedSession(tx: Tx) {
    const word = await seedSavedSenses(tx, { enrollmentId: enrollmentOf('u_1'), lemma: 'tome', translations: ['ספר'] });
    const sessionRepo = createSessionRepo(tx);
    const [typed] = await createQuestionRepo(tx).insertGeneratedQuestions({
      userId: 'u_1',
      enrollmentId: enrollmentOf('u_1'),
      targetLanguage: 'en',
      userLanguageCode: 'he',
      questions: [
        {
          senseId: word.senseIds[0],
          variantId: word.variantId,
          form: 'tome',
          lemma: 'tome',
          partOfSpeech: 'noun',
          lexemeId: word.lexemeId,
          type: 'typed_translation',
          prompt: 'ספר',
          options: null,
          alternatives: ['book'],
        },
      ],
    });
    const sessionId = await sessionRepo.insertPreparingSession('u_1', enrollmentOf('u_1'));
    await sessionRepo.insertSessionQuestions(sessionId, [typed]);
    return { sessionRepo, sessionId, typed };
  }

  it('writes an empty option order and round-trips the text and its verdict', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId, typed } = await typedSession(tx);
      const [{ order }] = await tx
        .select({ order: sessionQuestions.optionOrder })
        .from(sessionQuestions)
        .where(eq(sessionQuestions.sessionId, sessionId));
      expect(order).toEqual([]);

      await sessionRepo.insertAnswer(sessionId, 0, typed.id, { text: 'tomb', verdict: 'near_miss' });
      const loaded = await sessionRepo.loadSession(sessionId);
      expect(loaded!.questions).toEqual([typed]);
      expect(loaded!.answers).toEqual([
        { question_id: typed.id, is_correct: true, answer_string: 'tomb', verdict: 'near_miss' },
      ]);
    });
  });

  it('reads a wrong typed answer as incorrect', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId, typed } = await typedSession(tx);
      await sessionRepo.insertAnswer(sessionId, 0, typed.id, { text: '', verdict: 'wrong' });
      expect((await sessionRepo.loadSession(sessionId))!.answers[0]).toMatchObject({ is_correct: false, verdict: 'wrong' });
    });
  });

  // answers_kind_valid and answers_verdict_known (spec D12).
  it('refuses an answer with both an option and a text', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionId, typed } = await typedSession(tx);
      await expect(
        tx.insert(answers).values({ sessionId, position: 0, questionId: typed.id, selectedOptionPosition: 0, typedText: 'tome', verdict: 'exact' }),
      ).rejects.toThrow();
    });
  });

  it('refuses a text without a verdict', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionId, typed } = await typedSession(tx);
      await expect(tx.insert(answers).values({ sessionId, position: 0, questionId: typed.id, typedText: 'tome' })).rejects.toThrow();
    });
  });

  it('refuses an unknown verdict', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionId, typed } = await typedSession(tx);
      await expect(
        tx.insert(answers).values({ sessionId, position: 0, questionId: typed.id, typedText: 'tome', verdict: 'maybe' }),
      ).rejects.toThrow();
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

describe('session state (phase 19)', () => {
  const E = enrollmentOf('u_1');
  const repo = <T>(fn: (r: ReturnType<typeof createSessionRepo>) => Promise<T>) =>
    withTx(t.db, (tx) => fn(createSessionRepo(tx)));

  it('inserts a preparing list session, and refuses a second open one', async () => {
    const id = await repo((r) => r.insertPreparingSession('u_1', E));
    const state = await repo((r) => r.findState(id));
    expect(state).toEqual({ id, userId: 'u_1', enrollmentId: E, status: 'preparing', source: 'list' });
    await expect(repo((r) => r.insertPreparingSession('u_1', E))).rejects.toBeInstanceOf(SessionOpen);
  });

  it('refuses a seed session while one is open, as SessionOpen', async () => {
    await repo((r) => r.insertPreparingSession('u_1', E));
    await expect(withTx(t.db, (tx) => startSession(tx))).rejects.toBeInstanceOf(SessionOpen);
  });

  it('transitions only from the statuses named', async () => {
    const id = await repo((r) => r.insertPreparingSession('u_1', E));
    expect(await repo((r) => r.transition(id, ['ready'], 'skipped'))).toBe(false);
    expect(await repo((r) => r.transition(id, ['preparing'], 'ready'))).toBe(true);
    expect((await repo((r) => r.findState(id)))?.status).toBe('ready');
  });

  it('answers undefined, never a 22P02, for a malformed id', async () => {
    expect(await repo((r) => r.findState('nope'))).toBeUndefined();
    expect(await repo((r) => r.transition('nope', ['ready'], 'skipped'))).toBe(false);
  });

  it('summarises the newest session: answered and total', async () => {
    expect(await repo((r) => r.findLatest(E))).toBeUndefined();
    const { sessionId, record } = await withTx(t.db, (tx) => startSession(tx));
    await repo((r) => r.insertAnswer(sessionId, 0, record.questions[0].id, { displayIndex: 0 }));
    expect(await repo((r) => r.findLatest(E))).toEqual({
      id: sessionId,
      status: 'ready',
      source: 'seed',
      answered: 1,
      total: SESSION_LENGTH,
    });
  });

  it('loadSession reports status and source', async () => {
    const { sessionId } = await withTx(t.db, (tx) => startSession(tx));
    const loaded = await repo((r) => r.loadSession(sessionId));
    expect(loaded).toMatchObject({ status: 'ready', source: 'seed' });
  });
});
