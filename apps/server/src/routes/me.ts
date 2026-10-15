import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { ErrorSchema, MeResponseSchema, TimeZoneRequestSchema } from '@lang-tutor/core/api/schemas';

import { InvalidTimeZone } from '../errors';
import type { UserService } from '../services/users';
import { learnerResponses, signedInResponses, type ActorEnv } from './actor';

const meRoute = createRoute({
  method: 'get',
  path: '/me',
  tags: ['users'],
  summary: 'Who is signed in',
  description: 'The signed-in address and its profile; `user` is null until onboarding (POST /api/users).',
  responses: {
    200: { content: { 'application/json': { schema: MeResponseSchema } }, description: 'The signed-in user.' },
    ...signedInResponses,
  },
});

const timeZoneRoute = createRoute({
  method: 'put',
  path: '/me/time-zone',
  tags: ['users'],
  summary: 'Report your time zone',
  description:
    'The app reports its IANA time zone (for example `Asia/Jerusalem`) on every launch once signed in. ' +
    "The learner's day, and so their progress and their reminders, follow it. Idempotent.",
  request: {
    body: { required: true, content: { 'application/json': { schema: TimeZoneRequestSchema } } },
  },
  responses: {
    204: { description: 'The time zone is recorded.' },
    400: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'The body did not validate, or the name is not a time zone.',
    },
    ...learnerResponses,
  },
});

// Transport only (ADR 0001 R1). Mounted at /api, so this publishes as /api/me.
export function createMeRouter(users: UserService) {
  // The adapter's own 400 carries a Zod issue payload; the contract says
  // { error: 'invalid request' }.
  const router = new OpenAPIHono<ActorEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });
  router.openapi(meRoute, async (c) => c.json({ email: c.var.actorEmail, user: await users.me(c.var.actor) }, 200));

  router.openapi(timeZoneRoute, async (c) => {
    try {
      await users.setTimeZone(c.var.actor, c.req.valid('json').time_zone);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof InvalidTimeZone) return c.json({ error: 'invalid request' }, 400);
      throw error;
    }
  });
  return router;
}
