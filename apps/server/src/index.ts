import { serve } from '@hono/node-server';

import { createApp } from './app';
import { createDb } from './db/client';

const port = Number(process.env.PORT) || 3001;
const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/lang_tutor';

// The process is the composition root: the only place a connection is created.
const { db, close } = createDb(databaseUrl);

const server = serve({ fetch: createApp(db).fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`lang-tutor server listening on http://0.0.0.0:${info.port}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void close().then(() => process.exit(0));
    });
  });
}
