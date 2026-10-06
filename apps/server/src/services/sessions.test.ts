import { describe, expect, it } from '@jest/globals';

import { createFakeLlmClient, createFakeLogger } from '../../tests/support/fakes';
import { testRng } from '../../tests/support/testRng';
import { SessionNotFound } from '../errors';
import type { ProgressRepo } from '../repo/progress';
import type { QuestionRepo } from '../repo/questions';
import type { SessionRepo } from '../repo/sessions';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { UserRepo } from '../repo/users';
import type { DictRepo } from '../repo/dictionary';
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
    insertGeneratedQuestions: () => {
      throw new Error('submitAnswer must not write generated questions');
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
    findById: () => {
      throw new Error('the submit-answer use case must not read an enrollment');
    },
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

  function fakeTransaction(session: SessionRepo): Transaction {
    return (run) =>
      run({
        session,
        question: questionRepo,
        user: userRepo,
        enrollment: enrollmentRepo,
        dict: dictRepo,
        vocabulary: vocabularyRepo,
        progress: progressRepo,
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
      llm: createFakeLlmClient(''),
    });

    await expect(
      service.submitAnswer('00000000-0000-0000-0000-000000000000', 'q-window', 0),
    ).rejects.toBeInstanceOf(SessionNotFound);
  });
});
