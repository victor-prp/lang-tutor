import { describe, expect, it } from '@jest/globals';

import { createFakeLogger } from '../../tests/support/fakes';
import { testRng } from '../../tests/support/testRng';
import type { Db, Tx } from '../db/client';
import { SessionNotFound } from '../errors';
import type { SessionRepo } from '../repo/sessions';
import { createSessionService } from './sessions';

// The repository factories are the seam, so a handle that only knows how to run
// a transaction callback is enough — no Postgres, no clone, no globalSetup. The
// service's database-backed cases live in
// tests/integration/services/sessions.test.ts.
describe('repos', () => {
  function fakeDb(): Db {
    return {
      transaction: (run: (tx: Tx) => Promise<unknown>) => run({} as Tx),
    } as unknown as Db;
  }

  function sessionRepoWith(overrides: Partial<SessionRepo>): SessionRepo {
    const notStubbed = () => {
      throw new Error('this repository method should not have been called');
    };
    return {
      upsertUser: notStubbed,
      insertSession: notStubbed,
      loadSession: notStubbed,
      insertAnswer: notStubbed,
      completeSession: notStubbed,
      ...overrides,
    };
  }

  it('throws SessionNotFound when the repository reports no such session', async () => {
    const service = createSessionService({
      db: fakeDb(),
      rng: testRng(7),
      logger: createFakeLogger(),
      repos: {
        session: () => sessionRepoWith({ loadSession: async () => undefined }),
        question: () => {
          throw new Error('submitAnswer must not load the question pool');
        },
      },
    });

    await expect(
      service.submitAnswer('00000000-0000-0000-0000-000000000000', 'q-window', 0),
    ).rejects.toBeInstanceOf(SessionNotFound);
  });
});
