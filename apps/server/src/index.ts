import { serve } from '@hono/node-server';
import { PgBoss } from 'pg-boss';

import { createApp } from './app';
import { databaseNameFrom, loadAuthConfig, loadConfig, loadGeminiConfig } from './config';
import { createServerDeps } from './composition';
import { createDb } from './db/client';
import { JOB_SCHEMA } from './db/jobs';
import { createConsoleLogger } from './logger';
import { registerWorkers } from './worker';

// The process composition root: the only place that reads the environment, names
// a concrete logger or randomness source, opens a pool, or binds a port. Naming
// concrete things is what this file is for; everything it calls is a pure
// function a test can call with fakes.
export async function main(): Promise<void> {
  const config = loadConfig(process.env);
  // Before the pool: a misconfigured server should fail without having opened
  // a connection it will never use.
  const gemini = loadGeminiConfig(process.env);
  const authConfig = loadAuthConfig(process.env);
  // Constructed before the pool, because the pool's error policy closes over it.
  const logger = createConsoleLogger();

  const { db, close } = createDb(config.databaseUrl, {
    max: config.poolMax,
    onError: (error) => logger.error('idle postgres client', error),
  });

  // Phase 19. pg-boss on the same database, with a small pool of its own so job
  // polling never queues behind requests. migrate is off: db:migrate installed
  // the schema (db/jobs.ts), so a server that finds it missing fails loudly here
  // instead of migrating behind the operator's back. schedule is off (no cron);
  // supervision stays on, because workers now run and expiry and retry are its job.
  const boss = new PgBoss({
    connectionString: config.databaseUrl,
    schema: JOB_SCHEMA,
    max: 2,
    migrate: false,
    schedule: false,
  });
  boss.on('error', (error) => logger.error('pg-boss', error));
  await boss.start();

  const deps = createServerDeps({
    db,
    logger,
    rng: Math.random,
    now: Date.now,
    fetch: globalThis.fetch,
    gemini,
    auth: authConfig,
    translationTimeoutMs: config.translationTimeoutMs,
    sessionGenerationTimeoutMs: config.sessionGenerationTimeoutMs,
    speechTimeoutMs: config.speechTimeoutMs,
    judgeTimeoutMs: config.judgeTimeoutMs,
    photoReadTimeoutMs: config.photoReadTimeoutMs,
    // Resolved here, in the one place that reads the environment: app.ts must
    // not learn that a lane exists.
    identity: {
      lane: config.lane,
      database: databaseNameFrom(config.databaseUrl),
      port: config.port,
      version: config.version,
    },
    webDistDir: config.webDistDir,
    boss,
  });

  await registerWorkers(boss, deps, { pollingIntervalSeconds: 2 });

  const server = serve(
    { fetch: createApp(deps).fetch, port: config.port, hostname: '0.0.0.0' },
    (info) => {
      console.log(`lang-tutor server listening on http://0.0.0.0:${info.port}`);
    },
  );

  // HTTP first, so no new session is created mid-shutdown; then the workers
  // drain (a generation in flight finishes, or expires and is retried
  // elsewhere); the pool last, since both of the others use it. A stop that
  // rejects is logged, and the pool is still closed and the process still exits.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      server.close(() => {
        void boss
          .stop({ graceful: true, timeout: 30_000 })
          .catch((error: unknown) => logger.error('pg-boss stop', error))
          .then(() => close())
          .catch((error: unknown) => logger.error('pool close', error))
          .finally(() => process.exit(0));
      });
    });
  }
}

// Importing this file must not start a server — the pattern e2e/globalSetup.ts
// already uses.
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('lang-tutor server failed to start', error);
    process.exit(1);
  });
}
