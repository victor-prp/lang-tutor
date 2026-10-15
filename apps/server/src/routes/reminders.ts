import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  ErrorSchema,
  PushDeviceRequestSchema,
  PushDeviceUnregisterRequestSchema,
  ReminderSettingsResponseSchema,
  ReminderSettingsSchema,
} from '@lang-tutor/core/api/schemas';
import type { ReminderSettingsResponse } from '@lang-tutor/core/api';
import { z } from 'zod';

import { ReminderNotFound } from '../errors';
import type { ReminderService, ReminderView } from '../services/reminders';
import { learnerResponses, type ActorEnv } from './actor';

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});
// A string, not a uuid: a malformed id is the service's 404, and a route-level 400 would tell a
// prober which ids are well-formed.
const reminderParams = z.object({ id: z.string() });

const getRoute = createRoute({
  method: 'get',
  path: '/me/reminders',
  tags: ['reminders'],
  summary: 'Your reminder schedule',
  description:
    'The days, hours and daily target reminders follow, and the time zone those hours are read in. ' +
    'A learner who never saved a schedule gets the defaults: on, one session a day, every day, ' +
    'at 13:00, 17:00, 20:00 and 22:00.',
  responses: { 200: json(ReminderSettingsResponseSchema, 'The schedule.'), ...learnerResponses },
});

const putRoute = createRoute({
  method: 'put',
  path: '/me/reminders',
  tags: ['reminders'],
  summary: 'Save your reminder schedule',
  description:
    'Replaces the schedule whole. `days` are ISO weekdays (1 = Monday ... 7 = Sunday) and may be empty; ' +
    '`times` are `HH:MM` on your own clock. Both come back sorted and without repeats.',
  request: { body: { required: true, content: { 'application/json': { schema: ReminderSettingsSchema } } } },
  responses: {
    200: json(ReminderSettingsResponseSchema, 'The schedule as saved, with your time zone.'),
    400: json(ErrorSchema, 'The body did not validate.'),
    ...learnerResponses,
  },
});

const registerRoute = createRoute({
  method: 'put',
  path: '/me/push-devices',
  tags: ['reminders'],
  summary: 'Register a phone for reminders',
  description:
    'The app registers its push token once notifications are allowed. A token another account ' +
    'registered moves to the signed-in user: one phone, two accounts. Idempotent.',
  request: { body: { required: true, content: { 'application/json': { schema: PushDeviceRequestSchema } } } },
  responses: {
    204: { description: 'The token is registered.' },
    400: json(ErrorSchema, 'The body did not validate.'),
    ...learnerResponses,
  },
});

const unregisterRoute = createRoute({
  method: 'post',
  path: '/me/push-devices/unregister',
  tags: ['reminders'],
  summary: 'Stop reminders on a phone',
  description:
    "Removes the signed-in user's own token, before the app signs out. A token that is not theirs, " +
    'or not known, is left as it is and answers 204 as well.',
  request: { body: { required: true, content: { 'application/json': { schema: PushDeviceUnregisterRequestSchema } } } },
  responses: {
    204: { description: 'The token is not registered to the signed-in user any more.' },
    400: json(ErrorSchema, 'The body did not validate.'),
    ...learnerResponses,
  },
});

const tapRoute = createRoute({
  method: 'post',
  path: '/me/reminders/{id}/tap',
  tags: ['reminders'],
  summary: 'Report that a reminder was tapped',
  description:
    'The notification carries the reminder id, and the app reports the tap. The first tap sets the ' +
    "time and a repeat leaves it. 404 for a reminder that is not the signed-in user's, that does not " +
    'exist, or whose id is not a uuid.',
  request: { params: reminderParams },
  responses: {
    204: { description: 'The tap is recorded.' },
    404: json(ErrorSchema, 'No reminder of the signed-in user has this id.'),
    ...learnerResponses,
  },
});

// The wire is snake_case and the domain camelCase; this is where they meet.
const toResponse = ({ settings, timeZone }: ReminderView): ReminderSettingsResponse => ({
  enabled: settings.enabled,
  daily_target: settings.dailyTarget,
  days: settings.days,
  times: settings.times,
  time_zone: timeZone,
});

// Transport only (ADR 0001 R1). Mounted at /api; every route acts on the signed-in actor and
// no one else (ADR 0009 R3).
export function createRemindersRouter(reminders: ReminderService) {
  const router = new OpenAPIHono<ActorEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });

  router.openapi(getRoute, async (c) => c.json(toResponse(await reminders.settings(c.var.actor)), 200));

  router.openapi(putRoute, async (c) => {
    const body = c.req.valid('json');
    const saved = await reminders.putSettings(c.var.actor, {
      enabled: body.enabled,
      dailyTarget: body.daily_target,
      days: body.days,
      times: body.times,
    });
    return c.json(toResponse(saved), 200);
  });

  router.openapi(registerRoute, async (c) => {
    await reminders.registerDevice(c.var.actor, c.req.valid('json'));
    return c.body(null, 204);
  });

  router.openapi(unregisterRoute, async (c) => {
    await reminders.unregisterDevice(c.var.actor, c.req.valid('json').token);
    return c.body(null, 204);
  });

  router.openapi(tapRoute, async (c) => {
    try {
      await reminders.tap(c.var.actor, c.req.valid('param').id);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof ReminderNotFound) return c.json({ error: 'not found' }, 404);
      throw error;
    }
  });

  return router;
}
