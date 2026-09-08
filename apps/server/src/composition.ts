import type { GeminiConfig } from './config';
import type { Db } from './db/client';
import { createTransaction } from './db/transaction';
import type { Logger } from './logger';
import { createGeminiClient } from './providers/gemini';
import { createHealthRepo, type HealthRepo } from './repo/health';
import { createQuestionRepo } from './repo/questions';
import { createSessionRepo } from './repo/sessions';
import { createUserRepo } from './repo/users';
import type { LlmClient } from './services/llm';
import { createSessionService, type SessionService } from './services/sessions';
import { createTranslationService, type TranslationService } from './services/translations';
import { createUserService, type UserService } from './services/users';

export type AppDeps = {
  sessions: SessionService;
  users: UserService;
  translations: TranslationService;
  health: HealthRepo;
  logger: Logger;
};

// The provider's whole budget for one call. Ten seconds because a learner is
// waiting on it: no retry, no backoff — a learner who taps retry *is* the retry.
const TRANSLATION_TIMEOUT_MS = 10_000;

// Assembly only: no I/O, no logic, no conditionals beyond choosing an
// implementation. `db` and `logger` are received rather than built here because
// createDb opens a real pool — that stays in main(), and everything above it is
// a pure function a test can call.
export function createServerDeps(io: {
  db: Db;
  logger: Logger;
  rng: () => number;
  fetch: typeof globalThis.fetch;
  gemini: GeminiConfig;
}): AppDeps {
  // Binding the repositories to a transaction is assembly, which is what this
  // file is for. Doing it here is what lets services/ take a transaction rather
  // than a database.
  const transaction = createTransaction(io.db, (tx) => ({
    session: createSessionRepo(tx),
    question: createQuestionRepo(tx),
    user: createUserRepo(tx),
  }));

  // The one place in the repo that names both `createGeminiClient` and
  // `LlmClient` (ADR 0001 R11). The annotation below is what checks that the
  // provider satisfies the contract — providers/ cannot import it, exactly as
  // db/transaction.ts cannot import Transaction.
  const llm: LlmClient = createGeminiClient({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    timeoutMs: TRANSLATION_TIMEOUT_MS,
  });

  return {
    sessions: createSessionService({ transaction, rng: io.rng, logger: io.logger }),
    users: createUserService({ transaction, logger: io.logger }),
    translations: createTranslationService({ llm, logger: io.logger }),
    health: createHealthRepo(io.db),
    logger: io.logger,
  };
}
