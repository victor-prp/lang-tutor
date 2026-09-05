import type { Db } from './db/client';
import type { Logger } from './logger';
import { createHealthRepo, type HealthRepo } from './repo/health';
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
export function createServerDeps(io: { db: Db; logger: Logger }): AppDeps {
  return {
    sessions: createSessionService(io.db),
    health: createHealthRepo(io.db),
    logger: io.logger,
  };
}
