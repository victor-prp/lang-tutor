import { describe, expect, it } from '@jest/globals';

import { createFakeClock, createFakeJobRepo, createFakeLlmClient, createFakeLogger, createFakeTransaction, createFakeTranscriber, stub } from '../../tests/support/fakes';
import { testRng } from '../../tests/support/testRng';
import type { SessionRecord } from '../domain/session';
import { AnswerKindMismatch, SessionNotFound } from '../errors';
import type { ProgressRepo } from '../repo/progress';
import type { QuestionRepo } from '../repo/questions';
import type { SessionRepo } from '../repo/sessions';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { GrantRepo } from '../repo/grants';
import type { UserRepo } from '../repo/users';
import type { DictRepo } from '../repo/dictionary';
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
      countListSessions: notStubbed,
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
    findByUsername: () => {
      throw new Error('the session service must not look a username up');
    },
    findById: () => {
      throw new Error('the session service must not read the users table');
    },
  };

  // The submit-answer cases never reach it; createNextSession is the one use case
  // that does, and it is covered against real Postgres.
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
    findById: () => {
      throw new Error('the submit-answer use case must not read an enrollment');
    },
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
    findSavedSenseIds: forbidden,
    findWordsPage: forbidden,
    findWordSummaries: forbidden,
    findLemmaLexemes: forbidden,
    findLemmaRenderings: forbidden,
    findSavedInLemma: forbidden,
    listSavedSenses: forbidden,
    countEntries: forbidden,
  };

  // Phase 20. The one case here never completes or skips a session, so it never
  // reaches the progress rule.
  const unreachableProgress = () => {
    throw new Error('this case must not touch the progress tables');
  };
  const progressRepo: ProgressRepo = {
    findSessionEvidence: unreachableProgress,
    findRows: unreachableProgress,
    updateRows: unreachableProgress,
    insertSnapshot: unreachableProgress,
    findSnapshot: unreachableProgress,
    lockSessions: unreachableProgress,
    resetAll: unreachableProgress,
    listEndedSessions: unreachableProgress,
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
        vocabulary: vocabularyRepo,
        progress: progressRepo,
        photoImport: photoImportRepo,
        jobs: {
          enqueue: () => {
            throw new Error('the submit-answer use case must not enqueue a job');
          },
        },
      });
  }

  it('throws SessionNotFound when the repository reports no such session', async () => {
    const service = createSessionService({
      transaction: fakeTransaction(sessionRepoWith({ loadSession: async () => undefined })),
      rng: testRng(7),
      logger: createFakeLogger(),
      now: createFakeClock(0),
      llm: createFakeLlmClient(''),
      transcriber: createFakeTranscriber(''),
      judge: createFakeLlmClient(''),
    });

    await expect(
      service.submitAnswer('00000000-0000-0000-0000-000000000000', 'q-window', { option_index: 0 }),
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
      },
      { id: 'c2', type: 'multiple_choice', vocab_term_id: 'l2', question: 'casa', options: ['בית', 'דלת'], correct_option: 0 },
    ],
    answers: [],
    complete: false,
    completed_at: null,
    status: 'ready',
    source: 'list',
  };

  it('stores a typed answer with the verdict the learner was shown', async () => {
    const inserted: unknown[] = [];
    const service = createSessionService({
      transaction: fakeTransaction(
        sessionRepoWith({
          loadSession: async () => TYPED_SESSION,
          insertAnswer: async (...args) => {
            inserted.push(args);
          },
        }),
      ),
      rng: testRng(7),
      logger: createFakeLogger(),
      now: createFakeClock(0),
      llm: createFakeLlmClient(''),
      transcriber: createFakeTranscriber(''),
      judge: createFakeLlmClient(''),
    });

    const result = await service.submitAnswer('s1', 't1', { text: 'finestar' });
    expect(inserted).toEqual([['s1', 0, 't1', { text: 'finestar', verdict: 'near_miss' }]]);
    expect(result.answers[0]).toMatchObject({ is_correct: true, verdict: 'near_miss' });
  });

  it('refuses an option index on a typed card, writing nothing', async () => {
    const service = createSessionService({
      transaction: fakeTransaction(sessionRepoWith({ loadSession: async () => TYPED_SESSION })),
      rng: testRng(7),
      logger: createFakeLogger(),
      now: createFakeClock(0),
      llm: createFakeLlmClient(''),
      transcriber: createFakeTranscriber(''),
      judge: createFakeLlmClient(''),
    });

    await expect(service.submitAnswer('s1', 't1', { option_index: 0 })).rejects.toBeInstanceOf(AnswerKindMismatch);
  });
});

describe('createNextSession, phase 24 (spec D3, D5)', () => {
  const E = 'e1';
  it.each([true, false])('carries the listening flag, speaking %s and the list-session ordinal into the job', async (speaking) => {
    const jobs = createFakeJobRepo();
    const service = createSessionService({
      transaction: createFakeTransaction({
        enrollment: stub<EnrollmentRepo>({
          findById: async () => ({ id: E, user_id: 'u1', source_language: 'he', target_language: 'ru', created_at: '' }),
        }),
        session: stub<SessionRepo>({
          findLatest: async () => ({ id: 's0', status: 'completed', source: 'seed' }) as never,
          countListSessions: async () => 2,
          insertPreparingSession: async () => 's1',
        }),
        vocabulary: stub<VocabularyRepo>({
          listSavedSenses: async () => [{ senseId: 's1', variantId: 'v1', lexemeId: 'l1' }] as never,
        }),
        jobs,
      }),
      rng: testRng(7),
      logger: createFakeLogger(),
      now: createFakeClock(0),
      llm: createFakeLlmClient(''),
      transcriber: createFakeTranscriber(''),
      judge: createFakeLlmClient(''),
    });

    await service.createNextSession(E, { listening: true, speaking });
    expect(jobs.enqueued[0].data).toMatchObject({ listening: true, speaking, ordinal: 2 });
  });
});

