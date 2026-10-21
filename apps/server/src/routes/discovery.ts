import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  DiscoveryAnswerRequestSchema,
  DiscoveryAnswerResultSchema,
  DiscoveryProfileCreateSchema,
  DiscoveryProfileSchema,
  DiscoveryRunCreateSchema,
  DiscoveryRunSchema,
  DiscoveryStateSchema,
  ErrorSchema,
  PhotoImportItemSchema,
  PhotoImportItemUpdateSchema,
  SaveVocabularyResponseSchema,
} from '@lang-tutor/core/api/schemas';
import { z } from 'zod';

import {
  AccessDenied,
  DiscoveryConflict,
  DiscoveryNotFound,
  EnrollmentNotFound,
  InvalidDiscoveryItem,
  InvalidVocabularyEntry,
  LlmUnavailable,
  WrongScript,
} from '../errors';
import type { DiscoveryService } from '../services/discovery';
import { forbidden, learnerResponses, type ActorEnv } from './actor';

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});
const enrollmentParams = z.object({ id: z.string() });
const runParams = z.object({ id: z.string() });
const cardParams = z.object({ id: z.string(), position: z.coerce.number().int().nonnegative().max(2_147_483_647) });
const NO_ENROLLMENT = json(ErrorSchema, 'No enrollment has this id.');
const NO_RUN = json(ErrorSchema, 'No Words for me run has this id.');
const NO_CARD = json(ErrorSchema, 'No Words for me run has this id, or it has no such card.');
const UNAVAILABLE = json(ErrorSchema, 'The model could not propose words: try again.');
// Phase 69 (spec D10): Words for me is its list owner's alone.
const NOT_YOURS = forbidden("the enrollment, or the run's, is another learner's");

const stateRoute = createRoute({
  method: 'get',
  path: '/enrollments/{id}/discovery',
  tags: ['discovery'],
  summary: "Words for me: the learner's profile and open run",
  description: 'Each is null when there is none: no profile until the two questions are answered, no run unless one is open.',
  request: { params: enrollmentParams },
  responses: {
    200: json(DiscoveryStateSchema, 'The profile and the open run.'),
    404: NO_ENROLLMENT,
    ...learnerResponses,
    403: NOT_YOURS,
  },
});

const createProfileRoute = createRoute({
  method: 'post',
  path: '/enrollments/{id}/discovery/profile',
  tags: ['discovery'],
  summary: "The learner's two answers about their level",
  description: 'Asked once per enrollment. The level the first run starts at follows from self_level.',
  request: {
    params: enrollmentParams,
    body: { required: true, content: { 'application/json': { schema: DiscoveryProfileCreateSchema } } },
  },
  responses: {
    201: json(DiscoveryProfileSchema, 'The profile.'),
    400: json(ErrorSchema, 'The body did not validate.'),
    404: NO_ENROLLMENT,
    409: json(ErrorSchema, 'The enrollment has a profile already.'),
    ...learnerResponses,
    403: NOT_YOURS,
  },
});

const startRoute = createRoute({
  method: 'post',
  path: '/enrollments/{id}/discovery/runs',
  tags: ['discovery'],
  summary: 'Start a run of Words for me, or resume the open one',
  description:
    'A run collects goal words the learner did not know. It starts with no cards: ask for its first round. ' +
    'With a run open, answers it (200) and ignores the goal.',
  request: {
    params: enrollmentParams,
    body: { required: true, content: { 'application/json': { schema: DiscoveryRunCreateSchema } } },
  },
  responses: {
    201: json(DiscoveryRunSchema, 'A new run.'),
    200: json(DiscoveryRunSchema, 'The run already open.'),
    400: json(ErrorSchema, 'The body did not validate: a goal of 1 to 30.'),
    404: NO_ENROLLMENT,
    409: json(ErrorSchema, 'The enrollment has no profile yet.'),
    ...learnerResponses,
    403: NOT_YOURS,
  },
});

const getRunRoute = createRoute({
  method: 'get',
  path: '/discovery/runs/{id}',
  tags: ['discovery'],
  summary: 'One run: its unanswered cards and its list',
  request: { params: runParams },
  responses: {
    200: json(DiscoveryRunSchema, 'The run.'),
    404: NO_RUN,
    ...learnerResponses,
    403: NOT_YOURS,
  },
});

const nextRoundRoute = createRoute({
  method: 'post',
  path: '/discovery/runs/{id}/rounds',
  tags: ['discovery'],
  summary: "The run's next round of cards",
  description:
    'When the run asks and every card is answered, the model proposes the next round. Otherwise, or when another ' +
    'request wrote the round first, answers the run as it is. After the eighth round, or when no word is left, ' +
    'the run goes to its list instead.',
  request: { params: runParams },
  responses: {
    200: json(DiscoveryRunSchema, 'The run, with its next round or as it was.'),
    404: NO_RUN,
    502: UNAVAILABLE,
    ...learnerResponses,
    403: NOT_YOURS,
  },
});

const answerRoute = createRoute({
  method: 'post',
  path: '/discovery/runs/{id}/cards/{position}/answer',
  tags: ['discovery'],
  summary: 'Answer a card: "don\'t know", or its meaning typed in Hebrew',
  description:
    'A typed meaning is checked by rule, then by the model; one it cannot check counts as not known. A card not ' +
    'known joins the list and is looked up in the background. The answer that reaches the goal moves the run to ' +
    'its list. A card answered before answers its first verdict.',
  request: {
    params: cardParams,
    body: { required: true, content: { 'application/json': { schema: DiscoveryAnswerRequestSchema } } },
  },
  responses: {
    200: json(DiscoveryAnswerResultSchema, 'The verdict, the word\'s Hebrew, and the run.'),
    400: json(ErrorSchema, 'The body did not validate.'),
    404: NO_CARD,
    409: json(ErrorSchema, 'The run no longer asks.'),
    422: json(ErrorSchema, 'The answer is not written in the learner language\'s alphabet.'),
    ...learnerResponses,
    403: NOT_YOURS,
  },
});

const endRoute = createRoute({
  method: 'post',
  path: '/discovery/runs/{id}/end',
  tags: ['discovery'],
  summary: 'Go to the list now',
  request: { params: runParams },
  responses: {
    200: json(DiscoveryRunSchema, 'The run, listing.'),
    404: NO_RUN,
    409: json(ErrorSchema, 'The run was saved or discarded.'),
    ...learnerResponses,
    403: NOT_YOURS,
  },
});

const updateItemRoute = createRoute({
  method: 'patch',
  path: '/discovery/runs/{id}/items/{position}',
  tags: ['discovery'],
  summary: "Tick, untick or change a list row's gloss",
  request: {
    params: cardParams,
    body: { required: true, content: { 'application/json': { schema: PhotoImportItemUpdateSchema } } },
  },
  responses: {
    200: json(PhotoImportItemSchema, 'The row as it now is.'),
    400: json(ErrorSchema, "The body did not validate, the gloss is not one of the row's options, or the row has none to tick."),
    404: json(ErrorSchema, 'No run has this id, or its list has no such row.'),
    409: json(ErrorSchema, 'The run is not listing, or the row is still looked up.'),
    ...learnerResponses,
    403: NOT_YOURS,
  },
});

const saveRoute = createRoute({
  method: 'post',
  path: '/discovery/runs/{id}/save',
  tags: ['discovery'],
  summary: "Save the ticked rows' glosses to the learner's list",
  description: 'All or nothing, in one transaction, and the run becomes saved. Saving a saved run answers the same ids.',
  request: { params: runParams },
  responses: {
    200: json(SaveVocabularyResponseSchema, 'Every ticked gloss is now saved.'),
    400: json(ErrorSchema, 'A gloss cannot be saved in this enrollment.'),
    404: NO_RUN,
    409: json(ErrorSchema, 'The run is not listing, or a row is still looked up.'),
    ...learnerResponses,
    403: NOT_YOURS,
  },
});

const discardRoute = createRoute({
  method: 'post',
  path: '/discovery/runs/{id}/discard',
  tags: ['discovery'],
  summary: 'Discard a run without saving',
  description: 'Its answers stay. Idempotent on a discarded run.',
  request: { params: runParams },
  responses: {
    204: { description: 'The run is discarded.' },
    404: NO_RUN,
    409: json(ErrorSchema, 'The run was saved.'),
    ...learnerResponses,
    403: NOT_YOURS,
  },
});

/** The answers every discovery route shares; null when the error is not one of them. */
function shared(error: unknown): { body: { error: string }; status: 403 | 404 | 409 } | null {
  if (error instanceof AccessDenied) return { body: { error: 'forbidden' }, status: 403 };
  if (error instanceof EnrollmentNotFound) return { body: { error: 'enrollment not found' }, status: 404 };
  if (error instanceof DiscoveryNotFound) return { body: { error: 'discovery not found' }, status: 404 };
  if (error instanceof DiscoveryConflict) return { body: { error: 'discovery conflict' }, status: 409 };
  return null;
}

// Transport only (ADR 0001 R1). Mounted at /api.
export function createDiscoveryRouter(discovery: DiscoveryService) {
  const router = new OpenAPIHono<ActorEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });

  router.openapi(stateRoute, async (c) => {
    try {
      return c.json(await discovery.state(c.var.actor, c.req.valid('param').id), 200);
    } catch (error) {
      const known = shared(error);
      if (known && known.status !== 409) return c.json(known.body, known.status);
      throw error;
    }
  });

  router.openapi(createProfileRoute, async (c) => {
    try {
      return c.json(await discovery.createProfile(c.var.actor, c.req.valid('param').id, c.req.valid('json')), 201);
    } catch (error) {
      const known = shared(error);
      if (known) return c.json(known.body, known.status);
      throw error;
    }
  });

  router.openapi(startRoute, async (c) => {
    try {
      const { run, created } = await discovery.start(c.var.actor, c.req.valid('param').id, c.req.valid('json').goal);
      return created ? c.json(run, 201) : c.json(run, 200);
    } catch (error) {
      const known = shared(error);
      if (known) return c.json(known.body, known.status);
      throw error;
    }
  });

  router.openapi(getRunRoute, async (c) => {
    try {
      return c.json(await discovery.getRun(c.var.actor, c.req.valid('param').id), 200);
    } catch (error) {
      const known = shared(error);
      if (known && known.status !== 409) return c.json(known.body, known.status);
      throw error;
    }
  });

  router.openapi(nextRoundRoute, async (c) => {
    try {
      return c.json(await discovery.nextRound(c.var.actor, c.req.valid('param').id), 200);
    } catch (error) {
      if (error instanceof LlmUnavailable) return c.json({ error: 'words unavailable' }, 502);
      const known = shared(error);
      if (known && known.status !== 409) return c.json(known.body, known.status);
      throw error;
    }
  });

  router.openapi(answerRoute, async (c) => {
    const { id, position } = c.req.valid('param');
    try {
      return c.json(await discovery.answer(c.var.actor, id, position, c.req.valid('json')), 200);
    } catch (error) {
      if (error instanceof WrongScript) return c.json({ error: `the answer is not written in ${error.language}'s alphabet` }, 422);
      const known = shared(error);
      if (known) return c.json(known.body, known.status);
      throw error;
    }
  });

  router.openapi(endRoute, async (c) => {
    try {
      return c.json(await discovery.end(c.var.actor, c.req.valid('param').id), 200);
    } catch (error) {
      const known = shared(error);
      if (known) return c.json(known.body, known.status);
      throw error;
    }
  });

  router.openapi(updateItemRoute, async (c) => {
    const { id, position } = c.req.valid('param');
    try {
      return c.json(await discovery.updateItem(c.var.actor, id, position, c.req.valid('json')), 200);
    } catch (error) {
      if (error instanceof InvalidDiscoveryItem) return c.json({ error: 'invalid row change' }, 400);
      const known = shared(error);
      if (known) return c.json(known.body, known.status);
      throw error;
    }
  });

  router.openapi(saveRoute, async (c) => {
    try {
      return c.json(await discovery.save(c.var.actor, c.req.valid('param').id), 200);
    } catch (error) {
      if (error instanceof InvalidVocabularyEntry) return c.json({ error: 'invalid vocabulary entry' }, 400);
      const known = shared(error);
      if (known) return c.json(known.body, known.status);
      throw error;
    }
  });

  router.openapi(discardRoute, async (c) => {
    try {
      await discovery.discard(c.var.actor, c.req.valid('param').id);
      return c.body(null, 204);
    } catch (error) {
      const known = shared(error);
      if (known) return c.json(known.body, known.status);
      throw error;
    }
  });

  return router;
}
