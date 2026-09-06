import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { HealthResponseSchema } from '@lang-tutor/core/api/schemas';
import { Scalar } from '@scalar/hono-api-reference';
import { cors } from 'hono/cors';

import type { AppDeps } from './composition';
import { createSessionsRouter } from './routes/sessions';

// Readiness, not just liveness: the e2e suite waits on this before starting the
// app, and a 503 here is what distinguishes "server booting" from "broken".
// Both statuses are declared, so both are published.
const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  tags: ['health'],
  summary: 'Readiness check',
  responses: {
    200: {
      content: { 'application/json': { schema: HealthResponseSchema } },
      description: 'The server is ready to serve traffic.',
    },
    503: {
      content: { 'application/json': { schema: HealthResponseSchema } },
      description: 'The server is up but its database is not reachable.',
    },
  },
});

// Wires everything, holds no logic — and it does not know a database exists: no
// drizzle import, no Db, no SQL, and it never touches the console; every
// collaborator arrives in `deps`. An OpenAPIHono rather than a Hono because the
// route definitions below *are* the published description of this API.
export function createApp(deps: AppDeps) {
  const app = new OpenAPIHono();
  app.use('*', cors());

  app.openapi(healthRoute, async (c) => {
    const ok = await deps.health.ping();
    return ok ? c.json({ ok: true }, 200) : c.json({ ok: false }, 503);
  });

  app.route('/api/sessions', createSessionsRouter(deps.sessions));

  // Registered after the routes they describe, so the document is generated
  // from a fully-populated router. Always on: no auth, no secrets, and an
  // open-source client already describes this surface — gating adds
  // configuration and removes no risk.
  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'lang-tutor API',
      version: '0.1.0',
      description:
        'Sessions of ten multiple-choice questions for Hebrew speakers learning English.',
    },
  });
  app.get('/docs', Scalar({ url: '/openapi.json', pageTitle: 'lang-tutor API' }));

  app.onError((error, c) => {
    deps.logger.error('unhandled request error', error);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
