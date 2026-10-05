import { serve } from '@hono/node-server';
import { sql } from 'drizzle-orm';
import { PgBoss, fromDrizzle } from 'pg-boss';

import { createApp } from './app';
import { databaseNameFrom, loadConfig, loadGeminiConfig } from './config';
import { createServerDeps } from './composition';
import { createDb } from './db/client';
import { JOB_SCHEMA } from './db/jobs';
import { createConsoleLogger } from './logger';

// The process composition root: the only place that reads the environment, names
// a concrete logger or randomness source, opens a pool, or binds a port. Naming
// concrete things is what this file is for; everything it calls is a pure
// function a test can call with fakes.
export async function main(): Promise<void> {
  const config = loadConfig(process.env);
  // Before the pool: a misconfigured server should fail without having opened
  // a connection it will never use.
  const gemini = loadGeminiConfig(process.env);
  // Constructed before the pool, because the pool's error policy closes over it.
  const logger = createConsoleLogger();

  const { db, close } = createDb(config.databaseUrl, {
    max: config.poolMax,
    onError: (error) => logger.error('idle postgres client', error),
  });

  // Started here because starting is I/O and composition performs none: the
  // jobs repository's send() resolves its queue through a cache start() fills.
  // The schema and queues were installed by the migrations, so migrate is off;
  // no worker runs yet, so supervise, cron and the registry are off too.
  const boss = new PgBoss({
    db: fromDrizzle(db, sql),
    schema: JOB_SCHEMA,
    migrate: false,
    supervise: false,
    schedule: false,
    registerInstance: false,
  });
  boss.on('error', (error) => logger.error('pg-boss', error));
  await boss.start();

  const deps = createServerDeps({
    db,
    logger,
    rng: Math.random,
    fetch: globalThis.fetch,
    gemini,
    translationTimeoutMs: config.translationTimeoutMs,
    sessionGenerationTimeoutMs: config.sessionGenerationTimeoutMs,
    // Resolved here, in the one place that reads the environment: app.ts must
    // not learn that a lane exists.
    identity: {
      lane: config.lane,
      database: databaseNameFrom(config.databaseUrl),
      port: config.port,
    },
    boss,
  });

  const server = serve(
    { fetch: createApp(deps).fetch, port: config.port, hostname: '0.0.0.0' },
    (info) => {
      console.log(`lang-tutor server listening on http://0.0.0.0:${info.port}`);
    },
  );

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      server.close(() => {
        void boss
          .stop({ graceful: true, timeout: 5_000 })
          .then(close)
          .then(() => process.exit(0));
      });
    });
  }
}

// Importing this file must not start a server — the pattern e2e/globalSetup.ts
// already uses.
if (require.main === module) {
  void main();
}
