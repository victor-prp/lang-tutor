import { createHash, timingSafeEqual } from 'node:crypto';

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { ErrorSchema, ReminderTickResponseSchema } from '@lang-tutor/core/api/schemas';

import type { Logger } from '../logger';
import type { ReminderService } from '../services/reminders';

/**
 * Phase 52 (spec D5, D9). The reminder tick: EventBridge posts it every five minutes with
 * `Authorization: Bearer <REMINDER_SECRET>`, and it queues one run of the `remind` job. app.ts
 * mounts it only where REMINDER_SECRET is set, which is production alone; everywhere else
 * /api/internal/* answers 404. It sits outside the session middleware, as the bot route does:
 * the bearer secret is its only credential, and it acts for no learner.
 */
const errorBody = { 'application/json': { schema: ErrorSchema } };

const tickRoute = createRoute({
  method: 'post',
  path: '/internal/reminders/tick',
  tags: ['internal'],
  summary: 'Run the reminder tick',
  description:
    'Queues one run of the job that sends the practice reminders that are due. A run already queued or running absorbs it, so two ticks at once make one run. EventBridge only: mounted where REMINDER_SECRET is set.',
  security: [{ reminderSecret: [] }],
  responses: {
    202: { content: { 'application/json': { schema: ReminderTickResponseSchema } }, description: 'A run is queued, or one already was.' },
    401: { content: errorBody, description: 'No `Authorization: Bearer <REMINDER_SECRET>`, or the wrong secret.' },
  },
});

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Transport only (ADR 0001 R1). Mounted at /api. `secret` is REMINDER_SECRET.
 */
export function createInternalRemindersRouter({
  secret,
  reminders,
  logger,
}: {
  secret: string;
  reminders: ReminderService;
  logger: Logger;
}) {
  const router = new OpenAPIHono();
  router.openAPIRegistry.registerComponent('securitySchemes', 'reminderSecret', {
    type: 'http',
    scheme: 'bearer',
    description: 'REMINDER_SECRET. Only the reminder tick takes it.',
  });

  // Compared as SHA-256 digests, as routes/bots.ts compares its own: both sides are 32 bytes
  // whatever was sent, so timingSafeEqual neither throws on a length mismatch nor leaks the length.
  const expected = sha256(secret);
  const authorized = (header: string | undefined): boolean => {
    const given = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    return timingSafeEqual(sha256(given), expected) && given.length > 0;
  };

  // Every call: the secret first, then one log line with the status. Never the secret.
  router.use('/internal/reminders/*', async (c, next) => {
    if (!authorized(c.req.header('authorization'))) {
      c.res = c.json({ error: 'unauthorized' }, 401);
    } else {
      await next();
    }
    logger.info({ event: 'reminder_tick_route', status: c.res.status });
  });

  router.openapi(tickRoute, async (c) => {
    await reminders.requestTick();
    return c.json({ queued: true as const }, 202);
  });

  return router;
}
