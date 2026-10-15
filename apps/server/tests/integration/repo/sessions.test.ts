import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { AnswerVerdict } from '@lang-tutor/core/api';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';
import { eq } from 'drizzle-orm';

import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { CHOSEN_ON, NO_DEVICES, asChoice, insertListSession } from '../../support/questions';
import { testRng } from '../../support/testRng';
import { insertLexeme } from '../../support/dictRows';
import { seedSavedSenses } from '../../support/vocabularyRows';
import { withTx } from '../../support/withTx';
import type { Tx } from '../../../src/db/client';
import { newSessionRecord } from '../../../src/domain/session';
import { answers, sessionQuestions, sessions } from '../../../src/db/schema';
import { SessionOpen } from '../../../src/errors';
import { createQuestionRepo } from '../../../src/repo/questions';
import { createProgressRepo } from '../../../src/repo/progress';
import { createSessionRepo } from '../../../src/repo/sessions';
import { createVocabularyRepo } from '../../../src/repo/vocabulary';

// Phase 34 (spec D9). What every answer that opens no second try carries.
const NO_RETRY = { retry_state: null, retry_answer_string: null, retry_verdict: null };

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
  const sessionId = await sessionRepo.insertSession(userId, enrollmentOf(userId), record.questions, NO_DEVICES);
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
          ...NO_RETRY,
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
          glossId: word.glossIds[0],
          variantId: word.variantId,
          form: 'tome',
          lemma: 'tome',
          partOfSpeech: 'noun',
          lexemeId: word.lexemeId,
          type: 'typed_translation',
          prompt: 'ספר',
          options: null,
          alternatives: ['book'],
          tiles: null,
        },
      ],
    });
    const sessionId = await sessionRepo.insertPreparingSession('u_1', enrollmentOf('u_1'), NO_DEVICES, CHOSEN_ON);
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
        { question_id: typed.id, is_correct: true, answer_string: 'tomb', verdict: 'near_miss', ...NO_RETRY },
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
      await sessionRepo.completeSession(sessionId, '2026-03-04');

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
      await sessionRepo.completeSession(sessionId, '2026-03-04');
      expect(await sessionRepo.loadSession(sessionId)).toBeDefined();
    });
  });
});

describe('session state (phase 19)', () => {
  const E = enrollmentOf('u_1');
  const repo = <T>(fn: (r: ReturnType<typeof createSessionRepo>) => Promise<T>) =>
    withTx(t.db, (tx) => fn(createSessionRepo(tx)));

  it('inserts a preparing list session, and refuses a second open one', async () => {
    const id = await repo((r) => r.insertPreparingSession('u_1', E, NO_DEVICES, CHOSEN_ON));
    const state = await repo((r) => r.findState(id));
    expect(state).toEqual({ id, userId: 'u_1', enrollmentId: E, status: 'preparing', source: 'list' });
    await expect(repo((r) => r.insertPreparingSession('u_1', E, NO_DEVICES, CHOSEN_ON))).rejects.toBeInstanceOf(SessionOpen);
  });

  it('refuses a seed session while one is open, as SessionOpen', async () => {
    await repo((r) => r.insertPreparingSession('u_1', E, NO_DEVICES, CHOSEN_ON));
    await expect(withTx(t.db, (tx) => startSession(tx))).rejects.toBeInstanceOf(SessionOpen);
  });

  it('transitions only from the statuses named', async () => {
    const id = await repo((r) => r.insertPreparingSession('u_1', E, NO_DEVICES, CHOSEN_ON));
    expect(await repo((r) => r.transition(id, ['ready'], 'skipped'))).toBe(false);
    expect(await repo((r) => r.transition(id, ['preparing'], 'ready'))).toBe(true);
    expect((await repo((r) => r.findState(id)))?.status).toBe('ready');
  });

  it('answers undefined, never a 22P02, for a malformed id', async () => {
    expect(await repo((r) => r.findState('nope'))).toBeUndefined();
    expect(await repo((r) => r.transition('nope', ['ready'], 'skipped'))).toBe(false);
    expect(await repo((r) => r.findEnrollmentId('nope'))).toBeUndefined();
  });

  // Phase 29 (spec D13): what a session-addressed use case authorizes against.
  it('names the enrollment a session belongs to, and none for an unknown id', async () => {
    const id = await repo((r) => r.insertPreparingSession('u_1', E, NO_DEVICES, CHOSEN_ON));
    expect(await repo((r) => r.findEnrollmentId(id))).toBe(E);
    expect(await repo((r) => r.findEnrollmentId('00000000-0000-0000-0000-000000000000'))).toBeUndefined();
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

describe('phase 43: a started session and one in stock', () => {
  const E = enrollmentOf('u_1');
  const repo = <T>(fn: (r: ReturnType<typeof createSessionRepo>) => Promise<T>) =>
    withTx(t.db, (tx) => fn(createSessionRepo(tx)));

  it('keeps a stock beside a started session, and refuses a second of either', async () => {
    const { sessionId: started } = await withTx(t.db, (tx) => startSession(tx));
    expect(await repo((r) => r.markStarted(started))).toBe(true);
    const stock = await repo((r) => r.insertPreparingSession('u_1', E, NO_DEVICES, CHOSEN_ON));
    expect(await repo((r) => r.findOpen(E))).toEqual({
      started: { id: started, status: 'ready', source: 'seed', answered: 0, total: SESSION_LENGTH },
      stock: { id: stock, status: 'preparing', source: 'list', answered: 0, total: 0 },
    });
    await expect(repo((r) => r.insertPreparingSession('u_1', E, NO_DEVICES, CHOSEN_ON))).rejects.toBeInstanceOf(SessionOpen);

    await repo((r) => r.transition(stock, ['preparing'], 'ready'));
    await expect(repo((r) => r.markStarted(stock))).rejects.toBeInstanceOf(SessionOpen);
  });

  it('starts a session once', async () => {
    const { sessionId } = await withTx(t.db, (tx) => startSession(tx));
    expect(await repo((r) => r.markStarted(sessionId))).toBe(true);
    expect(await repo((r) => r.markStarted(sessionId))).toBe(false);
    expect(await repo((r) => r.markStarted('nope'))).toBe(false);
  });

  it('finds nothing open once both sessions end', async () => {
    expect(await repo((r) => r.findOpen(E))).toEqual({});
    const { sessionId } = await withTx(t.db, (tx) => startSession(tx));
    expect(await repo((r) => r.findOpen(E))).toEqual({
      stock: { id: sessionId, status: 'ready', source: 'seed', answered: 0, total: SESSION_LENGTH },
    });
    await repo((r) => r.transition(sessionId, ['ready'], 'skipped', '2026-10-12'));
    expect(await repo((r) => r.findOpen(E))).toEqual({});
  });

  it("stores what a session was built for, and reads the enrollment's newest", async () => {
    expect(await repo((r) => r.findNewestDevices(E))).toBeUndefined();
    const first = await repo((r) => r.insertPreparingSession('u_1', E, { listening: true, speaking: false }, CHOSEN_ON));
    expect(await repo((r) => r.findNewestDevices(E))).toEqual({ listening: true, speaking: false });
    await repo((r) => r.transition(first, ['preparing'], 'failed'));
    await repo((r) => r.insertPreparingSession('u_1', E, { listening: false, speaking: true }, CHOSEN_ON));
    expect(await repo((r) => r.findNewestDevices(E))).toEqual({ listening: false, speaking: true });
  });

  it('names the glosses a session asks, each once', async () => {
    const apple = await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'apple', translations: ['תפוח'] });
    const bread = await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'bread', translations: ['לחם'] });
    const word = (saved: typeof apple, lemma: string, translation: string) => ({
      glossId: saved.glossIds[0],
      variantId: saved.variantId,
      lexemeId: saved.lexemeId,
      form: lemma,
      lemma,
      translation,
    });
    const { sessionId } = await insertListSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      asked: [word(apple, 'apple', 'תפוח'), word(bread, 'bread', 'לחם'), word(apple, 'apple', 'תפוח')],
      types: ['multiple_choice', 'multiple_choice', 'typed_translation'],
    });
    expect((await repo((r) => r.findSessionGlosses(sessionId))).sort()).toEqual([apple.glossIds[0], bread.glossIds[0]].sort());
  });
});

describe('phase 53: the day a stock was chosen, and retiring it', () => {
  const E = enrollmentOf('u_1');
  const repo = <T>(fn: (r: ReturnType<typeof createSessionRepo>) => Promise<T>) =>
    withTx(t.db, (tx) => fn(createSessionRepo(tx)));
  const read = async (sessionId: string) =>
    (
      await t.db
        .select({ status: sessions.status, practiceDay: sessions.practiceDay, chosenOn: sessions.chosenOn })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
    )[0];
  /** A list session in stock, ready to be started. */
  const readyStock = async () => {
    const id = await repo((r) => r.insertPreparingSession('u_1', E, NO_DEVICES, CHOSEN_ON));
    await repo((r) => r.transition(id, ['preparing'], 'ready'));
    return id;
  };

  it('writes the learner day a stock was chosen, and reads it back with the devices it was built for', async () => {
    const id = await repo((r) => r.insertPreparingSession('u_1', E, { listening: true, speaking: false }, '2026-10-13'));
    expect((await read(id)).chosenOn).toBe('2026-10-13');
    expect(await repo((r) => r.findStockChoice(id))).toEqual({ chosenOn: '2026-10-13', listening: true, speaking: false });
  });

  it('has no day for a seed session, which is not chosen from a list', async () => {
    const { sessionId } = await withTx(t.db, (tx) => startSession(tx));
    expect(await repo((r) => r.findStockChoice(sessionId))).toEqual({ chosenOn: null, listening: false, speaking: false });
  });

  it('answers undefined, never a 22P02, for a session that is not there or an id that is not a uuid', async () => {
    expect(await repo((r) => r.findStockChoice('00000000-0000-0000-0000-000000000000'))).toBeUndefined();
    expect(await repo((r) => r.findStockChoice('nope'))).toBeUndefined();
  });

  it('retires a stock nobody has started, preparing or ready, and only once: it is skipped with no practice day', async () => {
    const preparing = await repo((r) => r.insertPreparingSession('u_1', E, NO_DEVICES, CHOSEN_ON));
    expect(await repo((r) => r.retireStock(preparing))).toBe(true);
    expect(await read(preparing)).toEqual({ status: 'skipped', practiceDay: null, chosenOn: CHOSEN_ON });
    expect(await repo((r) => r.retireStock(preparing))).toBe(false);
    // A retired stock no longer holds the enrollment's one place in stock.
    expect(await repo((r) => r.findOpen(E))).toEqual({});

    const ready = await readyStock();
    expect(await repo((r) => r.retireStock(ready))).toBe(true);
    expect(await read(ready)).toEqual({ status: 'skipped', practiceDay: null, chosenOn: CHOSEN_ON });
    expect(await repo((r) => r.findOpen(E))).toEqual({});
  });

  it('leaves a session alone once it was started', async () => {
    const id = await readyStock();
    expect(await repo((r) => r.markStarted(id))).toBe(true);

    expect(await repo((r) => r.retireStock(id))).toBe(false);

    expect((await read(id)).status).toBe('ready');
    expect(await repo((r) => r.findOpen(E))).toMatchObject({ started: { id, status: 'ready' } });
  });

  it('leaves a seed session alone: it is the first session, not a list stock', async () => {
    const { sessionId } = await withTx(t.db, (tx) => startSession(tx));

    expect(await repo((r) => r.retireStock(sessionId))).toBe(false);

    expect((await read(sessionId)).status).toBe('ready');
  });

  it('leaves a session alone that is completed, skipped or failed', async () => {
    const completed = await readyStock();
    await repo((r) => r.markStarted(completed));
    await repo((r) => r.completeSession(completed, '2026-10-14'));
    expect(await repo((r) => r.retireStock(completed))).toBe(false);
    expect(await read(completed)).toMatchObject({ status: 'completed', practiceDay: '2026-10-14' });

    const skipped = await repo((r) => r.insertPreparingSession('u_1', E, NO_DEVICES, CHOSEN_ON));
    await repo((r) => r.transition(skipped, ['preparing'], 'skipped', '2026-10-14'));
    expect(await repo((r) => r.retireStock(skipped))).toBe(false);
    expect(await read(skipped)).toMatchObject({ status: 'skipped', practiceDay: '2026-10-14' });

    const failed = await repo((r) => r.insertPreparingSession('u_1', E, NO_DEVICES, CHOSEN_ON));
    await repo((r) => r.transition(failed, ['preparing'], 'failed'));
    expect(await repo((r) => r.retireStock(failed))).toBe(false);
    expect((await read(failed)).status).toBe('failed');
  });

  it('answers false for a session that is not there or an id that is not a uuid', async () => {
    expect(await repo((r) => r.retireStock('00000000-0000-0000-0000-000000000000'))).toBe(false);
    expect(await repo((r) => r.retireStock('nope'))).toBe(false);
  });
});

describe('phase 24: boards', () => {
  it('round-trips a board, and reads a wrong board answer as the meaning tried', async () => {
    const words = [];
    for (const [lemma, translation] of [['tome', 'ספר'], ['quill', 'נוצה'], ['lantern', 'פנס'], ['kettle', 'קומקום']]) {
      const saved = await seedSavedSenses(t.db, { enrollmentId: enrollmentOf('u_1'), lemma, translations: [translation] });
      words.push({ glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation });
    }
    const { sessionId, questions } = await insertListSession(t.db, {
      userId: 'u_1',
      enrollmentId: enrollmentOf('u_1'),
      asked: words,
      types: ['matching', 'matching', 'matching', 'matching'],
    });
    const ids = questions.map((q) => q.id);

    await withTx(t.db, async (tx) => {
      const repo = createSessionRepo(tx);
      const loaded = await repo.loadSession(sessionId);
      loaded!.questions.forEach((q, i) => {
        if (q.type !== 'matching') throw new Error('unreachable');
        expect(q.board.question_ids).toEqual(ids);
        expect(q.board.correct_options[i]).toBe(i);
      });

      await repo.insertAnswer(sessionId, 0, ids[0], { displayIndex: 2 });
      const first = loaded!.questions[0];
      if (first.type !== 'matching') throw new Error('unreachable');
      expect((await repo.loadSession(sessionId))!.answers[0]).toEqual({
        question_id: ids[0],
        is_correct: false,
        answer_string: first.options[2],
        ...NO_RETRY,
      });
    });
  });
});

// Phase 35 (spec D5, D10). What the picker reads about today: the glosses asked
// in sessions counting for it (an open session counts as today), and how many
// glosses were first answered, while saved, on it.
describe('phase 37: answers and introductions on a day', () => {
  const E = enrollmentOf('u_1');
  const D1 = '2026-10-10';
  const D2 = '2026-10-11';
  type Word = { glossId: string; variantId: string; lexemeId: string; form: string; lemma: string; translation: string };

  async function savedWord(lemma: string, translation: string): Promise<Word> {
    const saved = await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [translation] });
    return { glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation };
  }

  async function unsavedWord(lemma: string, translation: string): Promise<Word> {
    const word = await insertLexeme(t.db, {
      lemma, languageCode: 'en', partOfSpeech: 'noun', userLanguageCode: 'he', senses: [{ senseCode: 'x' }],
      variants: [{ form: lemma, kind: 'word', entryRank: 0, translations: [{ senseCode: 'x', rank: 0, translation, exampleSource: null, exampleTarget: null }] }],
    });
    return { glossId: word.glossIds[0], variantId: word.variantIds[0], lexemeId: word.lexemeId, form: lemma, lemma, translation };
  }

  const save = (word: Word) =>
    withTx(t.db, (tx) =>
      createVocabularyRepo(tx).insertEntries({
        enrollmentId: E,
        addedByUserId: 'u_1',
        entries: [{ glossId: word.glossId, variantId: word.variantId, lexemeId: word.lexemeId, lemma: word.lemma }],
      }),
    );

  /** A multiple-choice session asking `asked`, the first `answered` of them
   *  answered, then skipped on `day` or left open. */
  async function play(asked: Word[], day: string | 'open', answered = asked.length, enrollmentId = E, userId = 'u_1') {
    const { sessionId, questions } = await insertListSession(t.db, {
      userId,
      enrollmentId,
      asked,
      types: asked.map(() => 'multiple_choice' as const),
    });
    await withTx(t.db, async (tx) => {
      const repo = createSessionRepo(tx);
      for (const [i, question] of questions.slice(0, answered).entries()) await repo.insertAnswer(sessionId, i, question.id, { displayIndex: 0 });
      if (day !== 'open') await repo.transition(sessionId, ['ready'], 'skipped', day);
    });
    return sessionId;
  }

  /** A session of typed translations, answered with `verdicts` in order, then
   *  skipped on `day` or left open. */
  async function playTyped(asked: Word[], day: string | 'open', verdicts: AnswerVerdict[]) {
    const { sessionId, questions } = await insertListSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      asked,
      types: asked.map(() => 'typed_translation' as const),
    });
    await withTx(t.db, async (tx) => {
      const repo = createSessionRepo(tx);
      for (const [i, verdict] of verdicts.entries()) await repo.insertAnswer(sessionId, i, questions[i].id, { text: 'x', verdict });
      if (day !== 'open') await repo.transition(sessionId, ['ready'], 'skipped', day);
    });
    return sessionId;
  }

  const read = <T>(run: (repo: ReturnType<typeof createSessionRepo>) => Promise<T>) => withTx(t.db, (tx) => run(createSessionRepo(tx)));

  it("reads the answers of that day's sessions and of an open one, in answer order, and no other enrollment's", async () => {
    const a = await savedWord('apple', 'תפוח');
    const b = await savedWord('bread', 'לחם');
    const c = await savedWord('cheese', 'גבינה');
    const d = await savedWord('dates', 'תמרים');
    const s1 = await playTyped([a, b], D1, ['exact']);
    const s2 = await playTyped([c, a], D2, ['exact', 'wrong']);
    const s3 = await playTyped([d], 'open', ['near_miss']);
    expect(await read((repo) => repo.findAnswersOn(E, D2))).toEqual([
      { glossId: c.glossId, sessionId: s2, type: 'typed_translation', verdict: 'exact' },
      { glossId: a.glossId, sessionId: s2, type: 'typed_translation', verdict: 'wrong' },
      { glossId: d.glossId, sessionId: s3, type: 'typed_translation', verdict: 'near_miss' },
    ]);
    expect((await read((repo) => repo.findAnswersOn(E, D1))).map((answer) => [answer.glossId, answer.sessionId])).toEqual([
      [a.glossId, s1],
      [d.glossId, s3],
    ]);
    await seedUser(t.db, 'u_2');
    expect(await read((repo) => repo.findAnswersOn(enrollmentOf('u_2'), D2))).toEqual([]);
  });

  it('leaves out an answer given before its gloss was saved, as the memory does', async () => {
    const a = await savedWord('apple', 'תפוח');
    const late = await unsavedWord('lemon', 'לימון');
    await playTyped([a, late], D2, ['exact', 'wrong']);
    await save(late);
    expect((await read((repo) => repo.findAnswersOn(E, D2))).map((answer) => answer.glossId)).toEqual([a.glossId]);
  });

  it("decodes a choice answer as the session's evidence does", async () => {
    const a = await savedWord('apple', 'תפוח');
    const b = await savedWord('bread', 'לחם');
    const sessionId = await play([a, b], D2);
    const evidence = await withTx(t.db, (tx) => createProgressRepo(tx).findSessionEvidence(sessionId));
    expect(await read((repo) => repo.findAnswersOn(E, D2))).toEqual(evidence!.answers.map((answer) => ({ ...answer, sessionId })));
  });

  it("reads a held answer by its retry, as the session's evidence does (phase 34, spec D9)", async () => {
    const a = await savedWord('apple', 'תפוח');
    const b = await savedWord('bread', 'לחם');
    const { sessionId, questions } = await insertListSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      asked: [a, b],
      types: ['typed_translation', 'typed_translation'],
    });
    await withTx(t.db, async (tx) => {
      const repo = createSessionRepo(tx);
      await repo.insertAnswer(sessionId, 0, questions[0].id, { text: 'x', verdict: 'alternative', pending: true });
      await repo.resolveRetry(sessionId, 0, { text: 'apple', verdict: 'exact' });
      await repo.insertAnswer(sessionId, 1, questions[1].id, { text: 'x', verdict: 'alternative', pending: true });
    });
    // The first resolved right, so it reads as its retry; the second is still pending.
    expect(await read((repo) => repo.findAnswersOn(E, D2))).toEqual([
      { glossId: a.glossId, sessionId, type: 'typed_translation', verdict: 'exact' },
      { glossId: b.glossId, sessionId, type: 'typed_translation', verdict: 'alternative' },
    ]);
  });

  it('names the glosses first answered while saved on that day, an open session counting as it', async () => {
    const a = await savedWord('apple', 'תפוח');
    const b = await savedWord('bread', 'לחם');
    const c = await savedWord('cheese', 'גבינה');
    const late = await unsavedWord('lemon', 'לימון');
    await play([a, late], D1);
    await save(late);
    expect(await read((repo) => repo.findIntroducedOn(E, D1))).toEqual([a.glossId]);
    // `a` is from D1. `late` was answered on D1 before it was saved, which introduced nothing.
    await play([a, b, late], D2);
    expect(await read((repo) => repo.findIntroducedOn(E, D2))).toEqual([b.glossId, late.glossId].sort());
    await play([c, a], 'open');
    expect(await read((repo) => repo.findIntroducedOn(E, D2))).toEqual([b.glossId, c.glossId, late.glossId].sort());
  });
});

describe('phase 25: spoken answers', () => {
  it('stores a spoken answer and a pass, and reads every verdict back', async () => {
    const asked = [];
    for (const [lemma, translation] of [
      ['tome', 'ספר'],
      ['lantern', 'פנס'],
    ]) {
      const saved = await seedSavedSenses(t.db, { enrollmentId: enrollmentOf('u_1'), lemma, translations: [translation] });
      asked.push({ glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation });
    }
    const { sessionId, questions } = await insertListSession(t.db, {
      userId: 'u_1',
      enrollmentId: enrollmentOf('u_1'),
      asked,
      alternatives: ['lamp'],
      types: ['read_aloud', 'say_translation'],
    });
    await withTx(t.db, async (tx) => {
      const repo = createSessionRepo(tx);
      await repo.insertAnswer(sessionId, 0, questions[0].id, { text: 'tome', verdict: 'understood' });
      await repo.insertAnswer(sessionId, 1, questions[1].id, { text: '', verdict: 'skipped' });
      expect((await repo.loadSession(sessionId))!.answers).toEqual([
        { question_id: questions[0].id, is_correct: true, answer_string: 'tome', verdict: 'understood', ...NO_RETRY },
        { question_id: questions[1].id, is_correct: false, answer_string: '', verdict: 'skipped', ...NO_RETRY },
      ]);
    });
  });
});

// Phase 34 (spec D9). A pending answer, its retry, and a skip's give-up.
describe('phase 34: the second try', () => {
  async function typedSession() {
    const asked = [];
    for (const [lemma, translation] of [
      ['tome', 'ספר'],
      ['lantern', 'פנס'],
    ]) {
      const saved = await seedSavedSenses(t.db, { enrollmentId: enrollmentOf('u_1'), lemma, translations: [translation] });
      asked.push({ glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation });
    }
    return insertListSession(t.db, {
      userId: 'u_1',
      enrollmentId: enrollmentOf('u_1'),
      asked,
      alternatives: ['lamp'],
      types: ['typed_translation', 'typed_translation'],
    });
  }

  it('stores an answer pending, resolves it with its retry, and reads both back', async () => {
    const { sessionId, questions } = await typedSession();
    await withTx(t.db, async (tx) => {
      const repo = createSessionRepo(tx);
      await repo.insertAnswer(sessionId, 0, questions[0].id, { text: 'lamp', verdict: 'alternative', pending: true });
      expect((await repo.loadSession(sessionId))!.answers).toEqual([
        { question_id: questions[0].id, is_correct: true, answer_string: 'lamp', verdict: 'alternative', retry_state: 'pending', retry_answer_string: null, retry_verdict: null },
      ]);
      await repo.resolveRetry(sessionId, 0, { text: 'tome', verdict: 'exact' });
      expect((await repo.loadSession(sessionId))!.answers[0]).toMatchObject({ retry_state: 'resolved', retry_answer_string: 'tome', retry_verdict: 'exact' });
    });
  });

  it('refuses to resolve an answer that is not pending', async () => {
    const { sessionId, questions } = await typedSession();
    await expect(
      withTx(t.db, async (tx) => {
        const repo = createSessionRepo(tx);
        await repo.insertAnswer(sessionId, 0, questions[0].id, { text: 'tome', verdict: 'exact' });
        await repo.resolveRetry(sessionId, 0, { text: 'tome', verdict: 'exact' });
      }),
    ).rejects.toThrow('has no pending answer at position 0');
  });

  it("gives up a session's pending answer, and leaves every other one alone", async () => {
    const { sessionId, questions } = await typedSession();
    await withTx(t.db, async (tx) => {
      const repo = createSessionRepo(tx);
      await repo.insertAnswer(sessionId, 0, questions[0].id, { text: 'tome', verdict: 'exact' });
      await repo.insertAnswer(sessionId, 1, questions[1].id, { text: 'lamp', verdict: 'alternative', pending: true });
      await repo.resolvePendingRetry(sessionId, { text: '', verdict: 'gave_up' });
      const [first, second] = (await repo.loadSession(sessionId))!.answers;
      expect(first).toMatchObject(NO_RETRY);
      expect(second).toMatchObject({ retry_state: 'resolved', retry_answer_string: '', retry_verdict: 'gave_up' });
      // Nothing pending: nothing to do.
      await repo.resolvePendingRetry(sessionId, { text: 'x', verdict: 'exact' });
      expect((await repo.loadSession(sessionId))!.answers[1]).toMatchObject({ retry_answer_string: '', retry_verdict: 'gave_up' });
    });
  });
});
