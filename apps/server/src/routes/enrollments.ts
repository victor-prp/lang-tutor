import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  CreateEnrollmentRequestSchema,
  EnrollmentListSchema,
  EnrollmentSchema,
  ErrorSchema,
} from '@lang-tutor/core/api/schemas';
import { z } from 'zod';

import { AlreadyEnrolled, UserNotFound } from '../errors';
import type { EnrollmentService } from '../services/enrollments';

const params = z.object({ id: z.string() });

const createEnrollmentRoute = createRoute({
  method: 'post',
  path: '/users/{id}/enrollments',
  tags: ['enrollments'],
  summary: 'Enroll a learner in a language',
  description:
    'Adds a course of study: one target language, explained in the source language. A learner ' +
    'holds at most one enrollment per target. In this version every enrollment is explained in ' +
    'Hebrew, so `source_language` must be `he`.',
  request: {
    params,
    body: {
      required: true,
      content: { 'application/json': { schema: CreateEnrollmentRequestSchema } },
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: EnrollmentSchema } },
      description: 'The enrollment was created.',
    },
    400: {
      content: { 'application/json': { schema: ErrorSchema } },
      description:
        'The request body did not validate: an unknown code, a source other than `he`, or the same language twice.',
    },
    404: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'No user has this id.',
    },
    409: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'The learner is already enrolled in this target language.',
    },
  },
});

const listEnrollmentsRoute = createRoute({
  method: 'get',
  path: '/users/{id}/enrollments',
  tags: ['enrollments'],
  summary: "List a learner's enrollments",
  description:
    "Every enrollment the learner holds, newest first. Which one is active is the client's business.",
  request: { params },
  responses: {
    200: {
      content: { 'application/json': { schema: EnrollmentListSchema } },
      description: 'The enrollments, possibly none.',
    },
    404: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'No user has this id.',
    },
  },
});

export function createEnrollmentsRouter(enrollments: EnrollmentService) {
  const router = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });

  router.openapi(createEnrollmentRoute, async (c) => {
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    try {
      return c.json(await enrollments.enroll(id, input), 201);
    } catch (error) {
      if (error instanceof UserNotFound) return c.json({ error: 'user not found' }, 404);
      if (error instanceof AlreadyEnrolled) return c.json({ error: 'already enrolled' }, 409);
      throw error;
    }
  });

  router.openapi(listEnrollmentsRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      return c.json(await enrollments.list(id), 200);
    } catch (error) {
      if (error instanceof UserNotFound) return c.json({ error: 'user not found' }, 404);
      throw error;
    }
  });

  return router;
}
