import { Hono } from 'hono';
import { cors } from 'hono/cors';

import type { AppDeps } from './composition';
import { createSessionsRouter } from './routes/sessions';

// Wires everything, holds no logic — and after this phase it does not know a
// database exists: no drizzle import, no Db, no SQL, no console. Every
// collaborator arrives in `deps`.
export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.use('*', cors());

  // Readiness, not just liveness: the e2e suite waits on this before starting the
  // app, and a 503 here is what distinguishes "server booting" from "broken".
  app.get('/health', async (c) => {
    const ok = await deps.health.ping();
    return ok ? c.json({ ok: true }) : c.json({ ok: false }, 503);
  });

  app.route('/api/sessions', createSessionsRouter(deps.sessions));

  app.onError((error, c) => {
    deps.logger.error('unhandled request error', error);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
