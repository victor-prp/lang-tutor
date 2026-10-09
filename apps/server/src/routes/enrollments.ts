import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  CreateEnrollmentRequestSchema,
  EnrollmentListSchema,
  EnrollmentSchema,
  ErrorSchema,
} from '@lang-tutor/core/api/schemas';

import { AlreadyEnrolled } from '../errors';
import type { EnrollmentService } from '../services/enrollments';
import { learnerResponses, type ActorEnv } from './actor';

// Phase 29 (spec D12). The signed-in user's own enrollments: no user id in the
// path, as /api/grants already is. The session middleware guarantees a
// profile, so "no such user" cannot happen here and is not published.

const createEnrollmentRoute = createRoute({
  method: 'post',
  path: '/enrollments',
  tags: ['enrollments'],
  summary: 'Enroll in a language',
  description:
    'Adds a course of study for the signed-in learner: one target language, explained in the ' +
    'source language. A learner holds at most one enrollment per target. In this version every ' +
    'enrollment is explained in Hebrew, so `source_language` must be `he`.',
  request: {
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
    409: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'The learner is already enrolled in this target language.',
    },
    ...learnerResponses,
  },
});

const listEnrollmentsRoute = createRoute({
  method: 'get',
  path: '/enrollments',
  tags: ['enrollments'],
  summary: 'Your enrollments',
  description:
    "Every enrollment the signed-in learner holds, newest first. Which one is active is the client's business.",
  responses: {
    200: {
      content: { 'application/json': { schema: EnrollmentListSchema } },
      description: 'The enrollments, possibly none.',
    },
    ...learnerResponses,
  },
});

// Transport only (ADR 0001 R1). Mounted at /api.
export function createEnrollmentsRouter(enrollments: EnrollmentService) {
  const router = new OpenAPIHono<ActorEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });

  router.openapi(createEnrollmentRoute, async (c) => {
    const input = c.req.valid('json');
    try {
      return c.json(await enrollments.enroll(c.var.actor, input), 201);
    } catch (error) {
      if (error instanceof AlreadyEnrolled) return c.json({ error: 'already enrolled' }, 409);
      throw error;
    }
  });

  router.openapi(listEnrollmentsRoute, async (c) => c.json(await enrollments.list(c.var.actor), 200));

  return router;
}
