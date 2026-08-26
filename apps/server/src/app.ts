import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { mockQuestions } from './data/mockQuestions';
import { createSessionsRouter } from './routes/sessions';
import { createSessionStore } from './store/sessionStore';

export function createApp() {
  const app = new Hono();
  app.use('*', cors());
  const store = createSessionStore();
  app.route('/api/sessions', createSessionsRouter(store, mockQuestions));
  return app;
}
