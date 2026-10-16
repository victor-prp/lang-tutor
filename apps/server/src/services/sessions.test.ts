import { describe, expect, it } from '@jest/globals';

import { createFakeClock, createFakeJobRepo, createFakeLlmClient, createFakeLogger, createFakeTransaction, createFakeTranscriber, stub } from '../../tests/support/fakes';
import { testRng } from '../../tests/support/testRng';
import type { GlossRendering, SessionRecord } from '../domain/session';
import { AnswerKindMismatch, NoSavedWords, SessionNotFound } from '../errors';
import type { GlossFamiliesRepo } from '../repo/glossFamilies';
import type { ModelCallRepo } from '../repo/modelCalls';
import type { PronunciationRepo } from '../repo/pronunciationScores';
import type { ReminderRepo } from '../repo/reminders';
import type { MemoryRepo } from '../repo/memory';
import type { ProgressRepo } from '../repo/progress';
import type { QuestionRepo } from '../repo/questions';
import type { SessionRepo } from '../repo/sessions';
import type { TargetRepo } from '../repo/targets';
import type { TargetSkillRepo } from '../repo/targetSkills';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { GrantRepo } from '../repo/grants';
import type { UserRepo } from '../repo/users';
import type { DictRepo } from '../repo/dictionary';
import type { GlossRepo } from '../repo/glosses';
import type { PhotoImportRepo } from '../repo/photoImports';
import type { VocabularyRepo } from '../repo/vocabulary';
import { createSessionService, type Transaction } from './sessions';

// The transaction seam is the repositories, so running the callback against
// stubs is enough — no Postgres, no clone, no globalSetup. Note that no cast is
// needed to build this: the service asks for exactly what it uses. The service's
// database-backed cases live in tests/integration/services/sessions.test.ts.
describe('repos', () => {
  const notStubbed = () => {
    throw new Error('this repository method should not have been called');
  };

  function sessionRepoWith(overrides: Partial<SessionRepo>): SessionRepo {
    return {
      insertSession: notStubbed,
      loadSession: notStubbed,
      insertAnswer: notStubbed,
      completeSession: notStubbed,
      insertPreparingSession: notStubbed,
      insertSessionQuestions: notStubbed,
      findState: notStubbed,
      transition: notStubbed,
      findLatest: notStubbed,
      findAnswersOn: notStubbed,
      findIntroducedOn: notStubbed,
      // Phase 34 (spec D9).
      resolveRetry: notStubbed,
      resolvePendingRetry: notStubbed,
      // Phase 43 (spec D1–D4).
      markStarted: notStubbed,
      lockNextSession: notStubbed,
      findOpen: notStubbed,
      findSessionGlosses: notStubbed,
      findNewestDevices: notStubbed,
      // Phase 57 (spec D2, ruling T3-j).
      findSessionCards: notStubbed,
      findLastAnswerAt: notStubbed,
      // Phase 53 (spec D12).
      findStockChoice: notStubbed,
      retireStock: notStubbed,
      // Phase 29: every session use case authorizes against this enrollment.
      findEnrollmentId: async () => 'e1',
      ...overrides,
    };
  }

  const questionRepo: QuestionRepo = {
    loadQuestionPool: () => {
      throw new Error('submitAnswer must not load the question pool');
    },
    findGenerationContext: () => {
      throw new Error('submitAnswer must not read the generation context');
    },
    findRecentSentences: () => {
      throw new Error('submitAnswer must not read recent sentences');
    },
    findRecentContexts: () => {
      throw new Error('submitAnswer must not read recent contexts');
    },
    insertGeneratedQuestions: () => {
      throw new Error('submitAnswer must not write generated questions');
    },
    findJudgeContext: () => {
      throw new Error('submitAnswer must not read the judge context');
    },
  };

  // Bound into the same transaction since phase 8, and untouched by these use
  // cases: reaching it here would mean the session service grew a second job.
  const userRepo: UserRepo = {
    insertUser: () => {
      throw new Error('the session service must not register a user');
    },
    // Read by learnerDay, wherever a session ends.
    findDayContext: async () => ({ kind: 'learner', timeZone: 'UTC' }),
    findByUsername: () => {
      throw new Error('the session service must not look a username up');
    },
    findById: () => {
      throw new Error('the session service must not read the users table');
    },
    insertBot: () => {
      throw new Error('the session service must not create a bot');
    },
    findBotByName: () => {
      throw new Error('the session service must not look a bot up');
    },
    setTimeZone: () => {
      throw new Error('the session service must not set a time zone');
    },
    findTimeZone: () => {
      throw new Error('the session service must not read a time zone');
    },
    setBotDay: () => {
      throw new Error("the session service must not move a bot's day");
    },
  };

  // Phase 29: read by the authorization of every use case, and for nothing else
  // here. The learner's own: the owner needs no grant read.
  const enrollmentRepo: EnrollmentRepo = {
    insertEnrollment: () => {
      throw new Error('the session service must not create an enrollment');
    },
    listByUser: () => {
      throw new Error('the session service must not list enrollments');
    },
    findByUserAndTarget: () => {
      throw new Error('the submit-answer use case must not look an enrollment up by target');
    },
    findById: async () => ({ id: 'e1', user_id: 'u1', source_language: 'he', target_language: 'en', created_at: '' }),
  };

  // Phase 28. Bound into the transaction, and never reached by these use cases.
  const noGrants = () => {
    throw new Error('the session service must not touch the grant tables');
  };
  const grantRepo: GrantRepo = {
    insertGrant: noGrants,
    findGrant: noGrants,
    findGrantFor: noGrants,
    acceptGrant: noGrants,
    deleteGrant: noGrants,
    listForOwner: noGrants,
    listForGrantee: noGrants,
  };

  // Bound into the same transaction since phase 10, and untouched by these use
  // cases: reaching it here would mean the session service grew a second job.
  const dictRepo: DictRepo = {
    findCorrectionByForm: () => {
      throw new Error('the session service must not read the dictionary tables');
    },
    findSenseVersion: () => {
      throw new Error('the session service must not read the dictionary tables');
    },
    findSensesByForm: () => {
      throw new Error('the session service must not read the dictionary tables');
    },
    findSensesByLexeme: () => {
      throw new Error('the session service must not read the dictionary tables');
    },
    findStaleLexemesByForm: () => {
      throw new Error('the session service must not read the dictionary tables');
    },
    lockLexemes: () => {
      throw new Error('the session service must not lock the dictionary tables');
    },
    persistCorrection: () => {
      throw new Error('the session service must not write the dictionary tables');
    },
    persistEntries: () => {
      throw new Error('the session service must not write the dictionary tables');
    },
    repairVariantRenderings: () => {
      throw new Error('the session service must not write the dictionary tables');
    },
    findLexemeForms: () => {
      throw new Error('the session service must not read the dictionary tables');
    },
    findLexeme: () => {
      throw new Error('the session service must not read the dictionary tables');
    },
    hasLemmaRendering: () => {
      throw new Error('the session service must not read the dictionary tables');
    },
    nextEntryRank: () => {
      throw new Error('the session service must not read the dictionary tables');
    },
    claimLemmaRenders: () => {
      throw new Error('the session service must not write the dictionary tables');
    },
    claimSavedLemmaRenders: () => {
      throw new Error('the session service must not write the dictionary tables');
    },
    releaseLemmaRender: () => {
      throw new Error('the session service must not write the dictionary tables');
    },
    // Phase 31. Read by createNextSession and prepareSession, which these cases are not.
    findGlossRenderings: () => {
      throw new Error('these cases must not read a gloss rendering');
    },
    findSiblings: () => {
      throw new Error('these cases must not read a sibling');
    },
    // Phase 34 (spec D3). Read by prepareSession, which these cases are not.
    findKnownRight: () => {
      throw new Error('these cases must not read what the dictionary knows to be right');
    },
    // Phase 34. The accept job's and the backfill's: the session service writes
    // no accepted answers (spec D1).
    findRenderingForAccept: () => {
      throw new Error('the session service must not read the dictionary tables');
    },
    storeAccepted: () => {
      throw new Error('the session service must not write the dictionary tables');
    },
    findUnacceptedSavedRenderings: () => {
      throw new Error('the session service must not read the dictionary tables');
    },
  };

  // Phase 31. Bound into the same transaction, and untouched by these cases:
  // none of them ends a session or prepares one, the two that resolve glosses.
  const glossRepo: GlossRepo = {
    resolveGlosses: () => {
      throw new Error('these cases must not resolve a gloss');
    },
    findMergeCandidates: () => {
      throw new Error('the session service must not merge glosses');
    },
    mergeGlosses: () => {
      throw new Error('the session service must not merge glosses');
    },
    findMergeWork: () => {
      throw new Error('the session service must not merge glosses');
    },
    setDefinitions: () => {
      throw new Error('the session service must not write the dictionary tables');
    },
  };

  // Bound into the same transaction since phase 18, and untouched by these use
  // cases: reaching it here would mean the session service grew a second job.
  const forbidden = () => {
    throw new Error('the session service must not touch the vocabulary tables');
  };
  const vocabularyRepo: VocabularyRepo = {
    findSaveable: forbidden,
    insertEntries: forbidden,
    deleteEntry: forbidden,
    findGlossIdsAtLevel: forbidden,
    findAllSavedGlossIds: forbidden,
    deleteEntries: forbidden,
    findSavedGlossIds: forbidden,
    findWordsPage: forbidden,
    findWordSummaries: forbidden,
    findLemmaLexemes: forbidden,
    markKnown: forbidden,
    findLemmaRenderings: forbidden,
    findSavedInLemma: forbidden,
    listSavedGlosses: forbidden,
    findSavedWords: forbidden,
    countEntries: forbidden,
  };

  // Phase 20. The one case here never completes or skips a session, so it never
  // reaches the progress rule.
  const unreachableProgress = () => {
    throw new Error('this case must not touch the progress tables');
  };
  const progressRepo: ProgressRepo = {
    lockEnrollment: unreachableProgress,
    lockSessionGlosses: unreachableProgress,
    findSessionEvidence: unreachableProgress,
    findRows: unreachableProgress,
    updateRows: unreachableProgress,
    insertSnapshot: unreachableProgress,
    findSnapshot: unreachableProgress,
    lockSessions: unreachableProgress,
    resetAll: unreachableProgress,
    listEndedSessions: unreachableProgress,
  };

  const memoryRepo: MemoryRepo = {
    findEnrollmentRows: unreachableProgress,
    findRows: unreachableProgress,
    upsertRows: unreachableProgress,
    deleteAll: unreachableProgress,
  };

  const photoImportRepo: PhotoImportRepo = {
    insertImport: forbidden,
    deleteExpired: forbidden,
    findImport: forbidden,
    findImportForUpdate: forbidden,
    findPhoto: forbidden,
    listOpen: forbidden,
    transition: forbidden,
    insertItems: forbidden,
    listItems: forbidden,
    findItem: forbidden,
    writeItem: forbidden,
    markItemFailed: forbidden,
    updateItem: forbidden,
  };

  function fakeTransaction(session: SessionRepo): Transaction {
    return (run) =>
      run({
        session,
        question: questionRepo,
        user: userRepo,
        enrollment: enrollmentRepo,
        grant: grantRepo,
        dict: dictRepo,
        gloss: glossRepo,
        vocabulary: vocabularyRepo,
        progress: progressRepo,
        memory: memoryRepo,
        glossFamilies: stub<GlossFamiliesRepo>({}),
        photoImport: photoImportRepo,
        modelCall: stub<ModelCallRepo>({}),
        pronunciation: stub<PronunciationRepo>({}),
        reminders: stub<ReminderRepo>({}),
        target: stub<TargetRepo>({}),
        targetSkills: stub<TargetSkillRepo>({}),
        // Phase 43 (spec D3). The one job an answer may ask for: the next session in stock.
        jobs,
      });
  }
  let jobs = createFakeJobRepo();

  it('throws SessionNotFound when the repository reports no such session', async () => {
    const service = createSessionService({
      transaction: fakeTransaction(
        sessionRepoWith({ findEnrollmentId: async () => undefined, loadSession: async () => undefined }),
      ),
      rng: testRng(7),
      logger: createFakeLogger(),
      now: createFakeClock(0),
      llm: createFakeLlmClient(''),
      contextLlm: createFakeLlmClient(''),
      checkerLlm: createFakeLlmClient(''),
      transcriber: createFakeTranscriber(''),
      judge: createFakeLlmClient(''),
      translationJudge: createFakeLlmClient(''),
      soundAlikeThreshold: 0.95,
    });

    await expect(
      service.submitAnswer('u1', '00000000-0000-0000-0000-000000000000', 'q-window', { option_index: 0 }),
    ).rejects.toBeInstanceOf(SessionNotFound);
  });

  // Phase 23. A typed card, the first of two, mid-session.
  const TYPED_SESSION: SessionRecord = {
    user_id: 'u1',
    questions: [
      {
        id: 't1',
        type: 'typed_translation',
        vocab_term_id: 'l1',
        question: 'חלון',
        part_of_speech: 'noun',
        answer: 'finestra',
        lemma: 'finestra',
        alternatives: [],
        context: null,
      },
      { id: 'c2', type: 'multiple_choice', vocab_term_id: 'l2', question: 'casa', options: ['בית', 'דלת'], correct_option: 0, context: null },
    ],
    answers: [],
    complete: false,
    completed_at: null,
    status: 'ready',
    source: 'list',
  };

  it('stores a typed answer with the verdict the learner was shown', async () => {
    const inserted: unknown[] = [];
    jobs = createFakeJobRepo();
    const service = createSessionService({
      transaction: fakeTransaction(
        sessionRepoWith({
          loadSession: async () => TYPED_SESSION,
          insertAnswer: async (...args) => {
            inserted.push(args);
          },
          // Phase 43 (spec D2). No start call came first: this answer starts it.
          markStarted: async () => true,
          // Phase 57 (spec D2). The main path's, whose next stock it asks for.
          findState: async () => ({ id: 's1', userId: 'u1', enrollmentId: 'e1', status: 'ready', source: 'list', targetId: null }),
        }),
      ),
      rng: testRng(7),
      logger: createFakeLogger(),
      now: createFakeClock(0),
      llm: createFakeLlmClient(''),
      contextLlm: createFakeLlmClient(''),
      checkerLlm: createFakeLlmClient(''),
      transcriber: createFakeTranscriber(''),
      judge: createFakeLlmClient(''),
      translationJudge: createFakeLlmClient(''),
      soundAlikeThreshold: 0.95,
    });

    const result = await service.submitAnswer('u1', 's1', 't1', { text: 'finestar' });
    // Phase 55 (spec D6): a typed card records whether it was helped, null from an app that sent none.
    expect(inserted).toEqual([['s1', 0, 't1', { text: 'finestar', verdict: 'near_miss', helped: null }]]);
    expect(result.answers[0]).toMatchObject({ is_correct: true, verdict: 'near_miss' });
    // Phase 43 (spec D2, D3). A first answer that started the session asks for the next in stock.
    expect(jobs.enqueued).toEqual([
      { name: 'stock-session', data: { enrollment_id: 'e1', reason: 'answer' }, options: { singletonKey: 'e1' } },
    ]);
  });

  it('refuses an option index on a typed card, writing nothing', async () => {
    const service = createSessionService({
      transaction: fakeTransaction(sessionRepoWith({ loadSession: async () => TYPED_SESSION })),
      rng: testRng(7),
      logger: createFakeLogger(),
      now: createFakeClock(0),
      llm: createFakeLlmClient(''),
      contextLlm: createFakeLlmClient(''),
      checkerLlm: createFakeLlmClient(''),
      transcriber: createFakeTranscriber(''),
      judge: createFakeLlmClient(''),
      translationJudge: createFakeLlmClient(''),
      soundAlikeThreshold: 0.95,
    });

    await expect(service.submitAnswer('u1', 's1', 't1', { option_index: 0 })).rejects.toBeInstanceOf(AnswerKindMismatch);
  });
});

// Phase 35 (spec D5, D10), phase 37 (D7). What createNextSession reads for
// chooseWords, for a list with no history: no memory, no levels, nothing
// answered or introduced today.
const SAVED_AT = '2026-10-01T09:00:00.000000Z';
/** Phase 39. The lexeme fields of a saved gloss: a lexeme of its own, so that no
 *  two glosses here make a family (spec D1). */
const lexeme = (lexemeId: string) => ({ lexemeId, lemma: lexemeId, form: lexemeId, order: [0, 0] as [number, number], knownAt: null });
const LEXEME = lexeme('l1');
/** Phase 39 (spec D4). No family stored yet. */
const noFamilies = { glossFamilies: stub<GlossFamiliesRepo>({ load: async () => [] }) };
// Phase 43 (spec D4, D5): and no session open, so create builds one with nothing in flight.
const nothingToday: Pick<SessionRepo, 'findAnswersOn' | 'findIntroducedOn' | 'findOpen' | 'lockNextSession'> = {
  findAnswersOn: async () => [],
  findIntroducedOn: async () => [],
  findOpen: async () => ({}),
  lockNextSession: async () => {},
};
const noHistory = {
  ...noFamilies,
  user: stub<UserRepo>({ findDayContext: async () => ({ kind: 'learner' as const, timeZone: 'UTC' }) }),
  memory: stub<MemoryRepo>({ findRows: async () => [] }),
  progress: stub<ProgressRepo>({ findRows: async () => [] }),
};

describe('createNextSession, phase 35 (spec D5, D10) and phase 37 (D1, D7)', () => {
  const E = 'e1';
  const TODAY = '2026-10-11';
  const saved = [
    { glossId: 'g_asked', key: 'כלב', variantId: 'v_asked', savedAt: '2026-10-11T08:00:00.000000Z', ...lexeme('l_asked') },
    { glossId: 'g_due', key: 'עט', variantId: 'v_due', savedAt: '2026-09-01T08:00:00.000000Z', ...lexeme('l_due') },
    { glossId: 'g_new', key: 'חתול', variantId: 'v_new', savedAt: '2026-10-10T08:00:00.000000Z', ...lexeme('l_new') },
  ];
  const DUE_STATE = { stability: 1, difficulty: 5, lastDay: '2026-09-01', reps: 1, lapses: 0, params: 'fsrs6-default' };
  // Met this morning and missed: an Again leaves stability under a day.
  const MISSED_STATE = { stability: 0.212, difficulty: 6.4, lastDay: TODAY, reps: 1, lapses: 1, params: 'fsrs6-default' };

  it("chooses from memory, levels, today's answers and the learner's day, and carries each pick's dimension, rung, level, R and return", async () => {
    const jobs = createFakeJobRepo();
    const reads: Record<string, unknown> = {};
    const service = createSessionService({
      transaction: createFakeTransaction({
        enrollment: stub<EnrollmentRepo>({
          findById: async () => ({ id: E, user_id: 'u1', source_language: 'he', target_language: 'en', created_at: '' }),
        }),
        user: stub<UserRepo>({
          findDayContext: async (userId) => {
            reads.dayOf = userId;
            return { kind: 'learner' as const, timeZone: 'UTC' };
          },
        }),
        session: stub<SessionRepo>({
          findLatest: async () => ({ id: 's0', status: 'completed', source: 'list' }) as never,
          findOpen: async () => ({}),
          lockNextSession: async () => {},
          insertPreparingSession: async () => 's1',
          findAnswersOn: async (enrollmentId, day) => {
            reads.answers = [enrollmentId, day];
            return [{ glossId: 'g_asked', sessionId: 's0', type: 'multiple_choice', correct: false, targetId: null }];
          },
          findIntroducedOn: async (enrollmentId, day) => {
            reads.introduced = [enrollmentId, day];
            return ['g_asked'];
          },
        }),
        vocabulary: stub<VocabularyRepo>({ listSavedGlosses: async () => saved }),
        memory: stub<MemoryRepo>({
          findRows: async (input) => {
            reads.memory = input;
            return [
              { glossId: 'g_due', dimension: 'written_receptive', state: DUE_STATE, reachedOn: null },
              { glossId: 'g_asked', dimension: 'written_receptive', state: MISSED_STATE, reachedOn: null },
            ];
          },
        }),
        progress: stub<ProgressRepo>({
          findRows: async (input) => {
            reads.levels = input;
            return [{ glossId: 'g_due', dimension: 'written_receptive', level: 4, lastStepOn: null, lastWrongOn: null }];
          },
        }),
        ...noFamilies,
        dict: stub<DictRepo>({
          findLexemeForms: async () => [],
          findGlossRenderings: async () =>
            saved.map((gloss, i) => ({ glossId: gloss.glossId, senseId: `s${i}`, variantId: gloss.variantId, form: `f${i}`, gloss: gloss.key, rank: 0 })),
        }),
        jobs,
      }),
      rng: testRng(7),
      logger: createFakeLogger(),
      now: createFakeClock(Date.parse(`${TODAY}T10:00:00Z`)),
      llm: createFakeLlmClient(''),
      contextLlm: createFakeLlmClient(''),
      checkerLlm: createFakeLlmClient(''),
      transcriber: createFakeTranscriber(''),
      judge: createFakeLlmClient(''),
      translationJudge: createFakeLlmClient(''),
      soundAlikeThreshold: 0.95,
    });

    await service.createNextSession('u1', E, { listening: false, speaking: false });

    // The day is the learner's (ADR 0013), and every read is over the saved list.
    expect(reads).toEqual({
      dayOf: 'u1',
      answers: [E, TODAY],
      introduced: [E, TODAY],
      memory: { enrollmentId: E, glossIds: ['g_asked', 'g_due', 'g_new'] },
      levels: { enrollmentId: E, glossIds: ['g_asked', 'g_due', 'g_new'], savedBy: null },
    });
    const { picks } = jobs.enqueued[0].data as { picks: Record<string, unknown>[] };
    // Phase 37 (spec D3): the new words, newest saved first, then the due word. Phase 54 (spec
    // D2): the word met this morning and missed, never answered right, is a new word again, not a
    // return. A return is carried as step in tests/integration/services/sessionsChoose.test.ts.
    // Phase 54 (spec D3, D7): each new word's pick is stored as a ladder, the due word's not.
    expect(picks).toEqual([
      { gloss_id: 'g_asked', sense_id: 's0', variant_id: 'v_asked', dimension: 'written_receptive', rung: 2, level: 1, r: 1, step: false, ladder: true },
      { gloss_id: 'g_new', sense_id: 's2', variant_id: 'v_new', dimension: 'written_receptive', rung: 1, level: 1, r: null, step: false, ladder: true },
      { gloss_id: 'g_due', sense_id: 's1', variant_id: 'v_due', dimension: 'written_receptive', rung: 1, level: 4, r: expect.any(Number), step: false, ladder: false },
    ]);
    expect(picks[2].r).toBeLessThan(0.75);
  });
});

describe('createNextSession, phase 24 (spec D3, D5)', () => {
  const E = 'e1';
  it.each([true, false])('carries the listening flag and speaking %s into the job, and no ordinal (phase 35, spec D6)', async (speaking) => {
    const jobs = createFakeJobRepo();
    const service = createSessionService({
      transaction: createFakeTransaction({
        enrollment: stub<EnrollmentRepo>({
          findById: async () => ({ id: E, user_id: 'u1', source_language: 'he', target_language: 'ru', created_at: '' }),
        }),
        session: stub<SessionRepo>({
          findLatest: async () => ({ id: 's0', status: 'completed', source: 'seed' }) as never,
          insertPreparingSession: async () => 's1',
          ...nothingToday,
        }),
        vocabulary: stub<VocabularyRepo>({
          listSavedGlosses: async () => [{ glossId: 'g1', key: 'עט', variantId: 'v1', savedAt: SAVED_AT, ...LEXEME }],
        }),
        ...noHistory,
        // Phase 31 (spec D12). The saved form's rendering, agreeing with the key.
        dict: stub<DictRepo>({
          findLexemeForms: async () => [],
          findGlossRenderings: async () => [{ glossId: 'g1', senseId: 's1', variantId: 'v1', form: 'ручка', gloss: 'עט', rank: 0 }],
        }),
        jobs,
      }),
      rng: testRng(7),
      logger: createFakeLogger(),
      now: createFakeClock(0),
      llm: createFakeLlmClient(''),
      contextLlm: createFakeLlmClient(''),
      checkerLlm: createFakeLlmClient(''),
      transcriber: createFakeTranscriber(''),
      judge: createFakeLlmClient(''),
      translationJudge: createFakeLlmClient(''),
      soundAlikeThreshold: 0.95,
    });

    await service.createNextSession('u1', E, { listening: true, speaking });
    expect(jobs.enqueued[0].data).toMatchObject({ listening: true, speaking });
    expect(jobs.enqueued[0].data).not.toHaveProperty('ordinal');
  });
});

// Phase 31 (spec D12). `finger` saved from `fingers`, whose rendering gave a
// drifted citation form: the saved form and the lemma form take turns, and a
// member rendering that agrees with neither the key nor the saved form is never asked.
describe('createNextSession, phase 31 (spec D12)', () => {
  const E = 'e1';
  const FINGERS: GlossRendering = { glossId: 'g1', senseId: 's1', variantId: 'v_fingers', form: 'fingers', gloss: 'אצבעות', rank: 0 };
  const FINGER: GlossRendering = { glossId: 'g1', senseId: 's1', variantId: 'v_finger', form: 'finger', gloss: 'אצבע', rank: 0 };
  const DIGITS: GlossRendering = { glossId: 'g1', senseId: 's2', variantId: 'v_digits', form: 'digits', gloss: 'ספרות', rank: 1 };

  function world(seed: number, renderings: GlossRendering[]) {
    const jobs = createFakeJobRepo();
    const reads: unknown[] = [];
    const service = createSessionService({
      transaction: createFakeTransaction({
        enrollment: stub<EnrollmentRepo>({
          findById: async () => ({ id: E, user_id: 'u1', source_language: 'he', target_language: 'en', created_at: '' }),
        }),
        session: stub<SessionRepo>({
          findLatest: async () => ({ id: 's0', status: 'completed', source: 'seed' }) as never,
          insertPreparingSession: async () => 's1',
          ...nothingToday,
        }),
        vocabulary: stub<VocabularyRepo>({
          listSavedGlosses: async () => [{ glossId: 'g1', key: 'אצבע', variantId: 'v_fingers', savedAt: SAVED_AT, ...LEXEME }],
        }),
        ...noHistory,
        dict: stub<DictRepo>({
          findLexemeForms: async () => [],
          findGlossRenderings: async (input) => {
            reads.push(input);
            return renderings;
          },
        }),
        jobs,
      }),
      rng: testRng(seed),
      logger: createFakeLogger(),
      now: createFakeClock(0),
      llm: createFakeLlmClient(''),
      contextLlm: createFakeLlmClient(''),
      checkerLlm: createFakeLlmClient(''),
      transcriber: createFakeTranscriber(''),
      judge: createFakeLlmClient(''),
      translationJudge: createFakeLlmClient(''),
      soundAlikeThreshold: 0.95,
    });
    return { service, jobs, reads };
  }

  it('picks one rendering per gloss among those agreeing with its key and its saved form, never a drifted one', async () => {
    const asked = new Set<string>();
    for (let seed = 1; seed <= 10; seed++) {
      const { service, jobs, reads } = world(seed, [DIGITS, FINGERS, FINGER]);
      await service.createNextSession('u1', E, { listening: false, speaking: false });
      expect(reads).toEqual([{ glossIds: ['g1'], userLanguageCode: 'he' }]);
      const picks = (jobs.enqueued[0].data as { picks: { gloss_id: string; sense_id: string; variant_id: string }[] }).picks.map(
        ({ gloss_id, sense_id, variant_id }) => ({ gloss_id, sense_id, variant_id }),
      );
      expect(picks).toHaveLength(1);
      expect([
        { gloss_id: 'g1', sense_id: 's1', variant_id: 'v_fingers' },
        { gloss_id: 'g1', sense_id: 's1', variant_id: 'v_finger' },
      ]).toContainEqual(picks[0]);
      asked.add(picks[0].variant_id);
    }
    expect(asked).toEqual(new Set(['v_fingers', 'v_finger']));
  });

  it('has nothing to ask, and enqueues nothing, when no picked gloss has a rendering', async () => {
    const { service, jobs } = world(1, []);
    await expect(service.createNextSession('u1', E, { listening: false, speaking: false })).rejects.toBeInstanceOf(NoSavedWords);
    expect(jobs.enqueued).toEqual([]);
  });
});

