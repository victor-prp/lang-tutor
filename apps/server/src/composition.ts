import type { Db } from './db/client';
import { createTransaction } from './db/transaction';
import type { Logger } from './logger';
import { createHealthRepo, type HealthRepo } from './repo/health';
import { createQuestionRepo } from './repo/questions';
import { createSessionRepo } from './repo/sessions';
import { createSessionService, type SessionService } from './services/sessions';

export type AppDeps = {
  sessions: SessionService;
  health: HealthRepo;
  logger: Logger;
};

// Assembly only: no I/O, no logic, no conditionals beyond choosing an
// implementation. `db` and `logger` are received rather than built here because
// createDb opens a real pool — that stays in main(), and everything above it is
// a pure function a test can call.
export function createServerDeps(io: { db: Db; logger: Logger; rng: () => number }): AppDeps {
  // Binding the repositories to a transaction is assembly, which is what this
  // file is for. Doing it here is what lets services/ take a transaction rather
  // than a database.
  const transaction = createTransaction(io.db, (tx) => ({
    session: createSessionRepo(tx),
    question: createQuestionRepo(tx),
  }));

  return {
    sessions: createSessionService({ transaction, rng: io.rng, logger: io.logger }),
    health: createHealthRepo(io.db),
    logger: io.logger,
  };
}
