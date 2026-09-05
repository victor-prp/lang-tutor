import type { Logger } from '../../src/logger';

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
