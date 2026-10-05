import type { PgBoss } from 'pg-boss';

import { createServerDeps, type AppDeps } from '../../src/composition';
import type { Db } from '../../src/db/client';
import type { Logger } from '../../src/logger';
import { unstartedBoss } from './jobs';

/**
 * Production's assembly with test-shaped I/O. Exists so a change to
 * createServerDeps's signature touches one file rather than every integration
 * test — the same reason ADR 0001 grants tests/support/ its composition-root
 * carve-out.
 *
 * `geminiBaseUrl` defaults to an unroutable namespace: a test that has not
 * registered a MockServer expectation should fail loudly rather than reach a
 * real provider. Tests that translate pass their own namespace URL.
 *
 * `translationTimeoutMs` defaults to production's own budget; a test proving
 * timeout behaviour overrides it to a short one rather than actually waiting
 * out 25 seconds of MockServer delay.
 */
export function createTestServerDeps(io: {
  db: Db;
  logger: Logger;
  rng: () => number;
  geminiBaseUrl?: string;
  translationTimeoutMs?: number;
  identity?: { lane: string; database: string; port: number };
  /** A started boss for tests that enqueue (startTestBoss). By default an
   *  unstarted one, so an unexpected enqueue fails loudly. */
  boss?: PgBoss;
  /** Phase 19, wired in Task 8. */
  sessionGenerationTimeoutMs?: number;
}): AppDeps {
  return createServerDeps({
    db: io.db,
    logger: io.logger,
    rng: io.rng,
    fetch: globalThis.fetch,
    gemini: {
      apiKey: 'test-key',
      baseUrl: io.geminiBaseUrl ?? 'http://127.0.0.1:9/never-registered',
      model: 'test-model',
    },
    translationTimeoutMs: io.translationTimeoutMs ?? 25_000,
    identity: io.identity ?? { lane: 'test', database: 'test_db', port: 0 },
    boss: io.boss ?? unstartedBoss(io.db),
  });
}
