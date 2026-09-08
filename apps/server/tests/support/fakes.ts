import type { User } from '@lang-tutor/core/api';

import type { AppDeps } from '../../src/composition';
import { UsernameTaken } from '../../src/errors';
import type { Logger } from '../../src/logger';
import type { UserRepo } from '../../src/repo/users';
import type { LlmClient, LlmJsonRequest } from '../../src/services/llm';
import type { SessionService } from '../../src/services/sessions';
import type { Repos, Transaction } from '../../src/services/transaction';
import type { UserService } from '../../src/services/users';

export type FakeLogger = Logger & {
  events: Record<string, unknown>[];
  errors: { message: string; cause?: unknown }[];
};

// A capturing Logger: a fake passed in, rather than a spy patched onto
// process-global `console` and mutated inside a Jest worker.
export function createFakeLogger(): FakeLogger {
  const events: Record<string, unknown>[] = [];
  const errors: { message: string; cause?: unknown }[] = [];
  return {
    events,
    errors,
    info: (event) => {
      events.push(event);
    },
    error: (message, cause) => {
      errors.push({ message, cause });
    },
  };
}

// For tests that assert something about the *shape* of the app rather than its
// behaviour — the published document, for one. Every collaborator throws,
// because a document is generated from route definitions and must never reach a
// handler; if one of these fires, the test is asserting the wrong thing.
export function createFakeAppDeps(): AppDeps {
  const unreachable = (): never => {
    throw new Error('a document-shape test must not reach a collaborator');
  };
  const sessions: SessionService = {
    startSession: unreachable,
    submitAnswer: unreachable,
  };
  const users: UserService = {
    register: unreachable,
    login: unreachable,
  };
  return {
    sessions,
    users,
    health: { ping: unreachable },
    logger: createFakeLogger(),
  };
}

/**
 * Replies in order; the last reply repeats once the queue is down to one, so a
 * test that calls twice does not have to say so. An Error in the queue is
 * thrown rather than returned, which is how a provider failure is simulated
 * without a socket.
 */
export function createFakeLlmClient(...replies: (string | Error)[]) {
  const calls: LlmJsonRequest[] = [];
  const queue = [...replies];

  const client: LlmClient = async (request) => {
    calls.push(request);
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next instanceof Error) throw next;
    return next;
  };

  return Object.assign(client, { calls });
}

// A repository a unit test can hold in its head: the same contract, backed by
// an array. It reproduces the one behaviour a caller depends on — a duplicate
// username raises UsernameTaken — because that is a contract of the interface,
// not an accident of Postgres.
export function createInMemoryUserRepo(): UserRepo & { rows: User[] } {
  const rows: User[] = [];
  let n = 0;
  return {
    rows,
    insertUser: async (input) => {
      if (rows.some((row) => row.username === input.username)) {
        throw new UsernameTaken(input.username);
      }
      const user: User = {
        id: `fake-user-${++n}`,
        username: input.username,
        display_name: input.display_name,
        age: input.age,
        native_language: input.native_language,
        target_language: input.target_language,
      };
      rows.push(user);
      return user;
    },
    findByUsername: async (username) => rows.find((row) => row.username === username),
    findById: async (id) => rows.find((row) => row.id === id),
  };
}

// A Proxy rather than a hand-listed stub: a test that reaches one of these
// should fail with the method name it reached for, and adding a repository
// method must not mean editing this file.
function unreachableRepo<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get: (_target, property) => () => {
      throw new Error(`${name}.${String(property)} must not be called by this test`);
    },
  });
}

/** Runs `run` immediately with the supplied user repo. No rollback, by design:
 *  a fake that pretended to roll back would be asserting a database behaviour
 *  it cannot actually provide. */
export function createFakeTransaction(user: UserRepo): Transaction {
  const repos: Repos = {
    user,
    session: unreachableRepo('session repo'),
    question: unreachableRepo('question repo'),
  };
  return (run) => run(repos);
}
