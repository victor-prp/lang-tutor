import { createHash, timingSafeEqual } from 'node:crypto';

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  BotDayRequestSchema,
  BotSignInRequestSchema,
  BotSignInResponseSchema,
  ErrorSchema,
} from '@lang-tutor/core/api/schemas';

import { UserNotFound } from '../errors';
import type { Logger } from '../logger';
import type { BotService } from '../services/bots';

/**
 * Phase 35 (spec D12, ADR 0013 R3). The bot route: the one route file that
 * knows BOT_SECRET or that a profile can be a bot. app.ts mounts it only when
 * BOT_SECRET is set, which is production alone; everywhere else /api/bots/*
 * answers 404. It sits outside the session middleware: the bearer secret is its
 * only credential, and a learner's name answers 404, the same as an unknown
 * one, so it can never sign anyone in as a learner.
 */
// The name a call gave, once its body validated: unset before then.
type BotEnv = { Variables: { botName: string | undefined } };

const errorBody = { 'application/json': { schema: ErrorSchema } };
const security = [{ botSecret: [] }];
const guarded = {
  400: { content: errorBody, description: 'The body did not validate.' },
  401: { content: errorBody, description: 'No `Authorization: Bearer <BOT_SECRET>`, or the wrong secret.' },
  404: { content: errorBody, description: 'No bot has this name. A learner\'s name answers the same.' },
};

const signInRoute = createRoute({
  method: 'post',
  path: '/bots/sign-in',
  tags: ['bots'],
  summary: 'Sign a bot in',
  description:
    'A Better Auth session for the bot profile `name`, as the whole `Cookie` header value to send with its requests. Bots only: mounted where BOT_SECRET is set.',
  security,
  request: { body: { required: true, content: { 'application/json': { schema: BotSignInRequestSchema } } } },
  responses: {
    200: { content: { 'application/json': { schema: BotSignInResponseSchema } }, description: 'Signed in.' },
    ...guarded,
  },
});

const dayRoute = createRoute({
  method: 'put',
  path: '/bots/day',
  tags: ['bots'],
  summary: "Set a bot's day",
  description:
    "Puts the bot `name` on `day`, the day its progress counts for. Explicit, so a retried run sets the same day again. Bots only: mounted where BOT_SECRET is set.",
  security,
  request: { body: { required: true, content: { 'application/json': { schema: BotDayRequestSchema } } } },
  responses: {
    204: { description: 'The bot is on that day.' },
    ...guarded,
  },
});

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Transport only (ADR 0001 R1). Mounted at /api. `secret` is BOT_SECRET.
 */
export function createBotsRouter({ secret, bots, logger }: { secret: string; bots: BotService; logger: Logger }) {
  const router = new OpenAPIHono<BotEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });
  router.openAPIRegistry.registerComponent('securitySchemes', 'botSecret', {
    type: 'http',
    scheme: 'bearer',
    description: 'BOT_SECRET. Only the bot route takes it.',
  });

  // Compared as SHA-256 digests: both sides are 32 bytes whatever was sent, so
  // timingSafeEqual neither throws on a length mismatch nor leaks the length.
  const expected = sha256(secret);
  const authorized = (header: string | undefined): boolean => {
    const given = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    return timingSafeEqual(sha256(given), expected) && given.length > 0;
  };

  // Every call: the secret first, before the body is read, then one log line
  // with the operation and the name (null when the call never got that far).
  // Never the secret or the cookie.
  router.use('/bots/*', async (c, next) => {
    if (!authorized(c.req.header('authorization'))) {
      c.res = c.json({ error: 'unauthorized' }, 401);
    } else {
      await next();
    }
    logger.info({
      event: 'bot_route',
      operation: c.req.path.split('/').pop(),
      name: c.var.botName ?? null,
      status: c.res.status,
    });
  });

  router.openapi(signInRoute, async (c) => {
    const { name } = c.req.valid('json');
    c.set('botName', name);
    try {
      return c.json(await bots.signIn(name), 200);
    } catch (error) {
      if (error instanceof UserNotFound) return c.json({ error: 'not found' }, 404);
      throw error;
    }
  });

  router.openapi(dayRoute, async (c) => {
    const { name, day } = c.req.valid('json');
    c.set('botName', name);
    try {
      await bots.setDay(name, day);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof UserNotFound) return c.json({ error: 'not found' }, 404);
      throw error;
    }
  });

  return router;
}
