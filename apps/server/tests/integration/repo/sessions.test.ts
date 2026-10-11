import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { AnswerVerdict } from '@lang-tutor/core/api';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';
import { eq } from 'drizzle-orm';

import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { asChoice, insertListSession } from '../../support/questions';
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
    expect(await repo((r) => r.findEnrollmentId('nope'))).toBeUndefined();
  });

  // Phase 29 (spec D13): what a session-addressed use case authorizes against.
  it('names the enrollment a session belongs to, and none for an unknown id', async () => {
    const id = await repo((r) => r.insertPreparingSession('u_1', E));
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
        { question_id: questions[0].id, is_correct: true, answer_string: 'tome', verdict: 'understood' },
        { question_id: questions[1].id, is_correct: false, answer_string: '', verdict: 'skipped' },
      ]);
    });
  });
});
