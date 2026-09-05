import { serve } from '@hono/node-server';

import { createApp } from './app';
import { loadConfig } from './config';
import { createServerDeps } from './composition';
import { createDb } from './db/client';
import { createConsoleLogger } from './logger';

// The process composition root: the only place that reads the environment, names
// a concrete logger or randomness source, opens a pool, or binds a port. Naming
// concrete things is what this file is for; everything it calls is a pure
// function a test can call with fakes.
export function main(): void {
  const config = loadConfig(process.env);
  // Constructed before the pool, because the pool's error policy closes over it.
  const logger = createConsoleLogger();

  const { db, close } = createDb(config.databaseUrl, {
    max: config.poolMax,
    onError: (error) => logger.error('idle postgres client', error),
  });

  const deps = createServerDeps({ db, logger });

  const server = serve(
    { fetch: createApp(deps).fetch, port: config.port, hostname: '0.0.0.0' },
    (info) => {
      console.log(`lang-tutor server listening on http://0.0.0.0:${info.port}`);
    },
  );

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      server.close(() => {
        void close().then(() => process.exit(0));
      });
    });
  }
}

// Importing this file must not start a server — the pattern e2e/globalSetup.ts
// already uses.
if (require.main === module) {
  main();
}
