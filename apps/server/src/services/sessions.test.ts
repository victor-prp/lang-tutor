import { describe, expect, it } from '@jest/globals';

import { createFakeLogger } from '../../tests/support/fakes';
import { testRng } from '../../tests/support/testRng';
import { SessionNotFound } from '../errors';
import type { QuestionRepo } from '../repo/questions';
import type { SessionRepo } from '../repo/sessions';
import type { UserRepo } from '../repo/users';
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
      upsertUser: notStubbed,
      insertSession: notStubbed,
      loadSession: notStubbed,
      insertAnswer: notStubbed,
      completeSession: notStubbed,
      ...overrides,
    };
  }

  const questionRepo: QuestionRepo = {
    loadQuestionPool: () => {
      throw new Error('submitAnswer must not load the question pool');
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

  function fakeTransaction(session: SessionRepo): Transaction {
    return (run) => run({ session, question: questionRepo, user: userRepo });
  }

  it('throws SessionNotFound when the repository reports no such session', async () => {
    const service = createSessionService({
      transaction: fakeTransaction(sessionRepoWith({ loadSession: async () => undefined })),
      rng: testRng(7),
      logger: createFakeLogger(),
    });

    await expect(
      service.submitAnswer('00000000-0000-0000-0000-000000000000', 'q-window', 0),
    ).rejects.toBeInstanceOf(SessionNotFound);
  });
});
