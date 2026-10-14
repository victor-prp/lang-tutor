import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { HealthResponseSchema } from '@lang-tutor/core/api/schemas';
import { API_LEVEL } from '@lang-tutor/core/apiLevel';
import { Scalar } from '@scalar/hono-api-reference';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';

import type { AppDeps } from './composition';
import { PROFILE_EXEMPT, createSessionMiddleware, type ActorEnv } from './routes/actor';
import { createApiLevelGate } from './routes/apiLevel';
import { registerAuthDocs } from './routes/authDocs';
import { createBotsRouter } from './routes/bots';
import { createEnrollmentsRouter } from './routes/enrollments';
import { createGrantsRouter } from './routes/grants';
import { createInternalRemindersRouter } from './routes/internalReminders';
import { createMeRouter } from './routes/me';
import { createPhotoImportsRouter } from './routes/photoImports';
import { createRemindersRouter } from './routes/reminders';
import { createSessionsRouter } from './routes/sessions';
import { createTranslationsRouter } from './routes/translations';
import { createUsersRouter } from './routes/users';
import { createVocabularyRouter } from './routes/vocabulary';
import { createWebHandler } from './web';

// Readiness, not just liveness: the e2e suite waits on this before starting the
// app, and a 503 here is what distinguishes "server booting" from "broken".
// Both statuses are declared, so both are published.
const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  tags: ['health'],
  summary: 'Readiness check',
  security: [],
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
  const app = new OpenAPIHono<ActorEnv>();
  // Phase 29 (spec D15). The lane's own web origins, with credentials: the
  // browser sends the session cookie only to an origin CORS names. The phone
  // sends no Origin and is unaffected.
  app.use('*', cors({ origin: deps.webOrigins, credentials: true }));
  // Phase 32 (spec D9). Before the auth mount and the session middleware, so an
  // old app is told to update rather than to sign in.
  app.use('/api/*', createApiLevelGate({ apiLevel: API_LEVEL }));

  app.openapi(healthRoute, async (c) => {
    const ok = await deps.health.ping();
    // The identity is on both bodies: a 503 from the wrong lane misleads exactly
    // as much as a 200 from it.
    const body = { ...deps.identity, ok };
    return ok ? c.json(body, 200) : c.json(body, 503);
  });

  // Phase 29 (spec D3; ADR 0003's second exception). Better Auth answers these
  // four paths and nothing else under /api/auth.
  for (const { method, path } of deps.auth.paths) {
    app.on(method, `/api/auth${path}`, (c) => deps.auth.handler(c.req.raw));
  }
  app.all('/api/auth/*', (c) => c.json({ error: 'not found' }, 404));
  registerAuthDocs(app);

  // Phase 35 (spec D12). The bot route, only where BOT_SECRET is set, and
  // before the session middleware: its bearer secret is its credential. Any
  // other /api/bots path, and every one where it is unmounted, is a 404 that
  // never reaches the session middleware, as with /api/auth.
  if (deps.bots) {
    app.route('/api', createBotsRouter({ secret: deps.bots.secret, bots: deps.bots.service, logger: deps.logger }));
  }
  app.all('/api/bots/*', (c) => c.json({ error: 'not found' }, 404));

  // Phase 52 (spec D5; ADR 0003's third exception). The reminder tick, only
  // where REMINDER_SECRET is set, and before the session middleware for the
  // bot route's reason: its bearer secret is its credential. Every other
  // /api/internal path, and the tick itself where it is unmounted, is a plain
  // 404 that never reaches the session middleware.
  if (deps.reminderTick) {
    app.route(
      '/api',
      createInternalRemindersRouter({
        secret: deps.reminderTick.secret,
        reminders: deps.reminderTick.service,
        logger: deps.logger,
      }),
    );
  }
  app.all('/api/internal/*', (c) => c.json({ error: 'not found' }, 404));

  // Phase 29 (spec D11). Everything under /api past this point needs a
  // session; all but PROFILE_EXEMPT also need a profile. Registered after the
  // auth mount and its 404, so those answer first and an unknown auth path
  // stays a 404 rather than a 401.
  app.use(
    '/api/*',
    createSessionMiddleware({
      sessionOf: deps.signedIn.sessionOf,
      hasProfile: deps.users.hasProfile,
      profileExempt: PROFILE_EXEMPT,
    }),
  );
  app.route('/api', createMeRouter(deps.users));
  app.route('/api', createRemindersRouter(deps.reminders));
  app.route('/api', createUsersRouter(deps.users));
  app.route('/api', createEnrollmentsRouter(deps.enrollments));
  app.route('/api', createGrantsRouter(deps.grants));
  app.route('/api', createVocabularyRouter(deps.vocabulary));
  app.route('/api', createPhotoImportsRouter(deps.photoImports));
  app.route('/api', createTranslationsRouter(deps.translations, deps.logger));
  app.route('/api', createSessionsRouter(deps.sessions));

  // Registered after the routes they describe, so the document is generated
  // from a fully-populated router. Always on: no auth, no secrets, and an
  // open-source client already describes this surface — gating adds
  // configuration and removes no risk.
  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    security: [{ sessionCookie: [] }],
    info: {
      title: 'lang-tutor API',
      version: '0.1.0',
      description:
        'Practice sessions for Hebrew speakers learning English, Russian or Italian: a seeded first session, then sessions built from the words each learner saves.',
    },
  });
  app.get('/docs', Scalar({ url: '/openapi.json', pageTitle: 'lang-tutor API' }));

  // Phase 30 (spec D1). Last, so it only sees what no route answered. Unset in
  // every lane and every test, where Metro or `expo serve` serves the app.
  if (deps.webDistDir) app.use('*', createWebHandler(deps.webDistDir));

  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: 'invalid request' }, error.status);
    deps.logger.error('unhandled request error', error);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
