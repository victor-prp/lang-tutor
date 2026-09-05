import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import type { Db } from './db/client';
import { createSessionsRouter } from './routes/sessions';
import { createSessionService } from './services/sessions';

// The composition root: receives the database handle, constructs the service,
// wires the router. It holds no logic and creates no connection of its own —
// which is what lets a test hand it a per-test database.
export function createApp(db: Db) {
  const app = new Hono();
  app.use('*', cors());

  // Readiness, not just liveness, now that a database has to be up first: the
  // e2e suite waits on this before starting the app, and a 503 here is what
  // distinguishes "server booting" from "server broken".
  app.get('/health', async (c) => {
    try {
      await db.execute(sql`select 1`);
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  app.route('/api/sessions', createSessionsRouter(createSessionService(db)));

  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
