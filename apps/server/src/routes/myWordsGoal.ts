import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { ErrorSchema, MyWordsGoalSchema } from '@lang-tutor/core/api/schemas';
import { z } from 'zod';

import { AccessDenied, EnrollmentNotFound } from '../errors';
import type { MyWordsGoalService } from '../services/myWordsGoal';
import { forbidden, learnerResponses, type ActorEnv } from './actor';

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});
const params = z.object({ id: z.string() });
const NO_ENROLLMENT = json(ErrorSchema, 'No enrollment has this id.');
// Phase 73 (spec D1): the goal is its course owner's alone.
const NOT_YOURS = forbidden("the enrollment is another learner's");

const getRoute = createRoute({
  method: 'get',
  path: '/enrollments/{id}/my-words-goal',
  tags: ['my words'],
  summary: "The course's daily My words goal",
  description:
    'Completed My words sessions a day, 1 to 20; 3 when the learner never chose one, null when the goal is off.',
  request: { params },
  responses: {
    200: json(MyWordsGoalSchema, 'The goal in force.'),
    404: NO_ENROLLMENT,
    ...learnerResponses,
    403: NOT_YOURS,
  },
});

const putRoute = createRoute({
  method: 'put',
  path: '/enrollments/{id}/my-words-goal',
  tags: ['my words'],
  summary: "Set the course's daily My words goal",
  description:
    'A number of sessions from 1 to 20, or null to turn the goal off. Today keeps counting: if today already ' +
    'has a record, it shows the new goal; earlier days keep theirs. Answers what it stored.',
  request: { params, body: { required: true, content: { 'application/json': { schema: MyWordsGoalSchema } } } },
  responses: {
    200: json(MyWordsGoalSchema, 'The goal now in force.'),
    400: json(ErrorSchema, 'The body did not validate: a whole number from 1 to 20, or null.'),
    404: NO_ENROLLMENT,
    ...learnerResponses,
    403: NOT_YOURS,
  },
});

export function createMyWordsGoalRouter(myWordsGoal: MyWordsGoalService) {
  const router = new OpenAPIHono<ActorEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });

  router.openapi(getRoute, async (c) => {
    try {
      return c.json(await myWordsGoal.goal(c.var.actor, c.req.valid('param').id), 200);
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      throw error;
    }
  });

  router.openapi(putRoute, async (c) => {
    try {
      return c.json(await myWordsGoal.putGoal(c.var.actor, c.req.valid('param').id, c.req.valid('json')), 200);
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      throw error;
    }
  });

  return router;
}
