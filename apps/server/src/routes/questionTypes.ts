import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  CreateQuestionTypeSessionRequestSchema,
  CreateQuestionTypeSessionResponseSchema,
  ErrorSchema,
  QuestionTypesQuerySchema,
  QuestionTypesResponseSchema,
} from '@lang-tutor/core/api/schemas';
import { z } from 'zod';

import {
  AccessDenied,
  EnrollmentNotFound,
  GlossNotSaved,
  NotATester,
  QuestionTypeUnavailable,
  RenderingMismatch,
  SeedPending,
} from '../errors';
import type { QuestionTypesService } from '../services/questionTypes';
import { forbidden, learnerResponses, type ActorEnv } from './actor';

const enrollmentParams = z.object({ id: z.string() });
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});
const TESTERS_ONLY = forbidden("the caller is not the list's owner (`forbidden`), or is not a tester (`not_a_tester`)");
const NOT_FOUND = json(ErrorSchema, 'No enrollment has this id, or the gloss is not saved in its list (`gloss_not_saved`).');

// Phase 61 (spec D2).
const readRoute = createRoute({
  method: 'get',
  path: '/enrollments/{id}/vocabulary/question-types',
  tags: ['vocabulary'],
  summary: 'Which question types one saved meaning can have',
  description:
    "For testers. Every question type, in the order a question-types session asks them, each available or not with why: the device has no voice for the target (`no_voice`) or cannot record (`no_microphone`), the form is too long to say (`too_long`), takes no tiles (`no_tiles`), has no gap in this meaning's example (`no_example_gap`), the word has no other saved meaning (`no_other_meaning`), or the type needs more words than one (`needs_more_words`). `sense_id` is the rendering a session of this meaning uses; send it back to create one.",
  request: { params: enrollmentParams, query: QuestionTypesQuerySchema },
  responses: {
    200: json(QuestionTypesResponseSchema, 'Every question type, and the rendering.'),
    400: json(ErrorSchema, 'The query did not validate.'),
    404: NOT_FOUND,
    ...learnerResponses,
    403: TESTERS_ONLY,
  },
});

// Phase 61 (spec D3).
const createSessionRoute = createRoute({
  method: 'post',
  path: '/enrollments/{id}/question-type-sessions',
  tags: ['sessions'],
  summary: "A session of one saved meaning's question types",
  description:
    'For testers. One card per chosen type, in the read\'s order, answered and counted as any session. It is put in stock, preparing, in place of a list session waiting there; a session started on the main path is skipped first, its answers counting as a skip\'s do. Read it with GET /sessions/{id}. A chosen type no card could be generated for is named in the session\'s `skipped_types`.',
  request: {
    params: enrollmentParams,
    body: { required: true, content: { 'application/json': { schema: CreateQuestionTypeSessionRequestSchema } } },
  },
  responses: {
    201: json(CreateQuestionTypeSessionResponseSchema, 'The session was created, preparing.'),
    400: json(
      ErrorSchema,
      'The body did not validate, a type is unavailable (`question_type_unavailable`), or `sense_id` is not the rendering the read answered (`rendering_mismatch`).',
    ),
    404: NOT_FOUND,
    409: json(ErrorSchema, 'The first, seeded session waits (`seed_pending`).'),
    ...learnerResponses,
    403: TESTERS_ONLY,
  },
});

/** The errors both routes share; null for one the caller rethrows. */
function shared(error: unknown) {
  if (error instanceof AccessDenied) return { body: { error: 'forbidden' }, status: 403 as const };
  if (error instanceof NotATester) return { body: { error: 'not_a_tester' }, status: 403 as const };
  if (error instanceof EnrollmentNotFound) return { body: { error: 'enrollment not found' }, status: 404 as const };
  if (error instanceof GlossNotSaved) return { body: { error: 'gloss_not_saved' }, status: 404 as const };
  return null;
}

// Transport only (ADR 0001 R1). Mounted at /api.
export function createQuestionTypesRouter(questionTypes: QuestionTypesService) {
  const router = new OpenAPIHono<ActorEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });

  router.openapi(readRoute, async (c) => {
    const { id } = c.req.valid('param');
    const query = c.req.valid('query');
    try {
      const body = await questionTypes.read(c.var.actor, id, {
        glossId: query.gloss_id,
        variantId: query.variant_id,
        listening: query.listening === 'true',
        speaking: query.speaking === 'true',
      });
      return c.json(body, 200);
    } catch (error) {
      const known = shared(error);
      if (known) return c.json(known.body, known.status);
      throw error;
    }
  });

  router.openapi(createSessionRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      return c.json(await questionTypes.create(c.var.actor, id, c.req.valid('json')), 201);
    } catch (error) {
      const known = shared(error);
      if (known) return c.json(known.body, known.status);
      if (error instanceof QuestionTypeUnavailable) return c.json({ error: 'question_type_unavailable' }, 400);
      if (error instanceof RenderingMismatch) return c.json({ error: 'rendering_mismatch' }, 400);
      if (error instanceof SeedPending) return c.json({ error: 'seed_pending' }, 409);
      throw error;
    }
  });

  return router;
}
