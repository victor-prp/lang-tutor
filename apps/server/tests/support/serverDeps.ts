import type { PgBoss } from 'pg-boss';

import { createServerDeps, type AppDeps } from '../../src/composition';
import type { Db } from '../../src/db/client';
import {
  CHECKER_CALL_BUDGET_MS,
  CONTEXT_CALL_BUDGET_MS,
  GAP_CHECK_BUDGET_MS,
  GAP_REWRITE_BUDGET_MS,
  PHOTO_READ_BUDGET_MS,
  SESSION_GENERATION_BUDGET_MS,
  STOCK_SAVE_DELAY_SECONDS,
} from '../../src/domain/jobs';
import { DISCOVERY_BUDGET_MS } from '../../src/domain/discovery';
import { DEFAULT_SOUND_ALIKE_THRESHOLD } from '../../src/domain/soundAlike';
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
  /** Phase 35. The clock; defaults to the real one. */
  now?: () => number;
  geminiBaseUrl?: string;
  /** Phase 29. Resend's base URL; defaults to an unroutable one, as Gemini's does. */
  mailBaseUrl?: string;
  translationTimeoutMs?: number;
  identity?: { lane: string; database: string; port: number; version: string; commit: string };
  /** A started boss for tests that enqueue (startTestBoss). By default an
   *  unstarted one, so an unexpected enqueue fails loudly. */
  boss?: PgBoss;
  /** Phase 19. The budget of one distractor call; defaults to production's. */
  sessionGenerationTimeoutMs?: number;
  /** Phase 34. The budget of the context call; defaults to production's. */
  contextCallTimeoutMs?: number;
  /** Phase 34. The budget of the checker; defaults to production's. */
  checkerCallTimeoutMs?: number;
  /** Phase 62c. The budgets of the gap check and the rewrite; default to production's. */
  gapCheckTimeoutMs?: number;
  gapRewriteTimeoutMs?: number;
  /** Phase 25. The budget of one transcription; defaults to production's. */
  speechTimeoutMs?: number;
  /** Phase 27. The budget of one judged answer; defaults to production's. */
  judgeTimeoutMs?: number;
  /** Phase 69. The budget of one round of Words for me; defaults to production's. */
  discoveryTimeoutMs?: number;
  /** Phase 26. A read's budget; defaults to production's. */
  photoReadTimeoutMs?: number;
  /** Phase 43. How long a save's stock waits; defaults to production's. */
  stockSaveDelaySeconds?: number;
  /** Phase 50. The sound-alike threshold; defaults to production's. */
  soundAlikeThreshold?: number;
  /** Phase 35 (spec D12). Mounts the bot route; unset, as on every lane. */
  botSecret?: string | null;
  /** Phase 52. Expo's base URL; defaults to an unroutable one, as Gemini's does. */
  pushBaseUrl?: string;
  /** Phase 75. Where a reminder's pictures are served; none by default, as on every lane. */
  reminderImageBaseUrl?: string | null;
  /** Phase 52 (spec D5). Mounts the reminder tick route; unset, as on every lane. */
  reminderSecret?: string | null;
}): AppDeps {
  return createServerDeps({
    // No request lines: a test's logger keeps to the events it asserts on.
    requestLog: null,
    db: io.db,
    logger: io.logger,
    rng: io.rng,
    now: io.now ?? Date.now,
    fetch: globalThis.fetch,
    gemini: {
      apiKey: 'test-key',
      baseUrl: io.geminiBaseUrl ?? 'http://127.0.0.1:9/never-registered',
      model: 'test-model',
    },
    auth: {
      secret: 'test-secret-that-is-at-least-32-chars',
      baseUrl: 'http://localhost',
      webOrigins: ['https://web.example.test'],
      resendApiKey: 'test-key',
      resendBaseUrl: io.mailBaseUrl ?? 'http://127.0.0.1:9/never-registered',
      mailFrom: 'test@example.com',
      reviewerCodes: new Map(),
    },
    translationTimeoutMs: io.translationTimeoutMs ?? 25_000,
    sessionGenerationTimeoutMs: io.sessionGenerationTimeoutMs ?? SESSION_GENERATION_BUDGET_MS,
    contextCallTimeoutMs: io.contextCallTimeoutMs ?? CONTEXT_CALL_BUDGET_MS,
    checkerCallTimeoutMs: io.checkerCallTimeoutMs ?? CHECKER_CALL_BUDGET_MS,
    gapCheckTimeoutMs: io.gapCheckTimeoutMs ?? GAP_CHECK_BUDGET_MS,
    gapRewriteTimeoutMs: io.gapRewriteTimeoutMs ?? GAP_REWRITE_BUDGET_MS,
    speechTimeoutMs: io.speechTimeoutMs ?? 8_000,
    judgeTimeoutMs: io.judgeTimeoutMs ?? 8_000,
    discoveryTimeoutMs: io.discoveryTimeoutMs ?? DISCOVERY_BUDGET_MS,
    photoReadTimeoutMs: io.photoReadTimeoutMs ?? PHOTO_READ_BUDGET_MS,
    stockSaveDelaySeconds: io.stockSaveDelaySeconds ?? STOCK_SAVE_DELAY_SECONDS,
    soundAlikeThreshold: io.soundAlikeThreshold ?? DEFAULT_SOUND_ALIKE_THRESHOLD,
    identity: io.identity ?? { lane: 'test', database: 'test_db', port: 0, version: 'test', commit: 'test' },
    webDistDir: null,
    botSecret: io.botSecret ?? null,
    pushBaseUrl: io.pushBaseUrl ?? 'http://127.0.0.1:9/never-registered',
    reminderImageBaseUrl: io.reminderImageBaseUrl ?? null,
    reminderSecret: io.reminderSecret ?? null,
    boss: io.boss ?? unstartedBoss(io.db),
  });
}
