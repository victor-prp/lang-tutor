import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { mockQuestions } from './data/mockQuestions';
import { createSessionsRouter } from './routes/sessions';
import { createSessionStore } from './store/sessionStore';

export function createApp() {
  const app = new Hono();
  app.use('*', cors());
  // Liveness probe. Deliberately reads no session state and takes no
  // parameters, so a readiness poll cannot perturb the store. When storage
  // lands this is where a DB-connectivity check belongs.
  app.get('/health', (c) => c.json({ ok: true }));
  const store = createSessionStore();
  app.route('/api/sessions', createSessionsRouter(store, mockQuestions));
  return app;
}
