import type { AppDeps } from '../../src/composition';
import type { Logger } from '../../src/logger';
import type { SessionService } from '../../src/services/sessions';

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
  return {
    sessions,
    health: { ping: unreachable },
    logger: createFakeLogger(),
  };
}
