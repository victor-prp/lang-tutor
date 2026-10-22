import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { ErrorSchema, MeResponseSchema, NewWordLimitsSchema, TimeZoneRequestSchema } from '@lang-tutor/core/api/schemas';

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

const limitsJson = (description: string) => ({ content: { 'application/json': { schema: NewWordLimitsSchema } }, description });

const newWordsRoute = createRoute({
  method: 'get',
  path: '/me/new-words',
  tags: ['users'],
  summary: 'Your new-word limits',
  description:
    'How many new words you meet a day (`day_cap`), every list path and target together, and how many a ' +
    'regular session includes (`per_session`; null is automatic: up to two, one when reviews are due). ' +
    "A learner who never chose gets 15 and automatic. A homework or exam's planned words meet past the cap.",
  responses: { 200: limitsJson('The limits in force.'), ...learnerResponses },
});

const putNewWordsRoute = createRoute({
  method: 'put',
  path: '/me/new-words',
  tags: ['users'],
  summary: 'Save your new-word limits',
  description:
    'Replaces both. The next session chosen follows them; one already prepared keeps the words it was chosen with.',
  request: { body: { required: true, content: { 'application/json': { schema: NewWordLimitsSchema } } } },
  responses: {
    200: limitsJson('The limits as saved.'),
    400: { content: { 'application/json': { schema: ErrorSchema } }, description: 'The body did not validate.' },
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

  router.openapi(newWordsRoute, async (c) => c.json(await users.newWordLimits(c.var.actor), 200));
  router.openapi(putNewWordsRoute, async (c) => c.json(await users.putNewWordLimits(c.var.actor, c.req.valid('json')), 200));
  return router;
}
