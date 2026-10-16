import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  AddTargetWordsRequestSchema,
  ChangeTargetDateRequestSchema,
  CreateTargetRequestSchema,
  ErrorSchema,
  TargetListSchema,
  TargetRefusalSchema,
  TargetSchema,
} from '@lang-tutor/core/api/schemas';
import { z } from 'zod';

import {
  AccessDenied,
  EnrollmentNotFound,
  InvalidTarget,
  InvalidVocabularyEntry,
  PhotoImportConflict,
  PhotoImportNotFound,
  TargetClosed,
  TargetNotFound,
} from '../errors';
import type { TargetService } from '../services/targets';
import { forbidden, learnerResponses, type ActorEnv } from './actor';

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});
const enrollmentParams = z.object({ id: z.string() });
const targetParams = z.object({ id: z.string() });
const wordParams = z.object({ id: z.string(), gloss_id: z.string() });
const NOT_ENROLLED = json(ErrorSchema, 'No enrollment has this id.');
const NO_TARGET = json(ErrorSchema, 'No target has this id.');
// Phase 53 (spec D2): a target is its list owner's alone, a tutor of the list included.
const OWNER_ONLY = forbidden(
  "the caller is not the list's owner, who alone may read or change a target, a tutor of the list included",
);
const NOT_READY = json(
  ErrorSchema,
  'A photo import is not ready to save: still being read or looked up, saved or discarded already, or expired.',
);
const closed = (what: string) =>
  json(ErrorSchema, 'The target is closed, so ' + what + ': it was ended early, or its date has come.');
// A photo import the body names that is unknown, or another list's, is refused as an invalid target.
const UNKNOWN_IMPORT = { error: 'invalid target', reason: 'unknown_import' } as const;

const listRoute = createRoute({
  method: 'get',
  path: '/enrollments/{id}/targets',
  tags: ['targets'],
  summary: "An enrollment's active targets",
  description:
    'The targets through their due date that were not ended early, nearest date first, each with its day (work owed, ' +
    'done or rest, readiness in percent, the words at 100%) and its path\'s session, and the learner\'s today, which the ' +
    'date a target is given must come after.',
  request: { params: enrollmentParams },
  responses: {
    200: json(TargetListSchema, 'The active targets, possibly none.'),
    404: NOT_ENROLLED,
    ...learnerResponses,
    403: OWNER_ONLY,
  },
});

const createTargetRoute = createRoute({
  method: 'post',
  path: '/enrollments/{id}/targets',
  tags: ['targets'],
  summary: 'Prepare for homework or a test',
  description:
    "A kind (homework or exam), a due date after the learner's today (YYYY-MM-DD, a day the calendar has), and the " +
    'words to learn: photo imports, one per photo (a failed one is skipped), and typed words. Their words are saved ' +
    "into the enrollment's list, the imports become saved, and the target is made, all in one transaction. At least " +
    'one word must come out of them.',
  request: {
    params: enrollmentParams,
    body: { required: true, content: { 'application/json': { schema: CreateTargetRequestSchema } } },
  },
  responses: {
    201: json(TargetSchema, 'The target, with its words and their readiness.'),
    400: json(
      TargetRefusalSchema,
      "The body did not validate (`invalid request`); the due date is not after the learner's today, no word came out of " +
        "the photos and typed words, or a photo import is unknown or another list's (`invalid target`, with a `reason`: " +
        '`due_date`, `no_words` or `unknown_import`); or a typed word cannot be saved here (`invalid vocabulary entry`).',
    ),
    404: NOT_ENROLLED,
    409: NOT_READY,
    ...learnerResponses,
    403: OWNER_ONLY,
  },
});

const getTargetRoute = createRoute({
  method: 'get',
  path: '/targets/{id}',
  tags: ['targets'],
  summary: 'One target with its words',
  description:
    'Any target of the learner, an ended one or one whose date has come included. Its words are in the order they were added.',
  request: { params: targetParams },
  responses: {
    200: json(TargetSchema, 'The target, with its words and their readiness for its date.'),
    404: NO_TARGET,
    ...learnerResponses,
    403: OWNER_ONLY,
  },
});

const changeDateRoute = createRoute({
  method: 'patch',
  path: '/targets/{id}',
  tags: ['targets'],
  summary: "Move a target's date",
  description:
    "To any day after the learner's today (YYYY-MM-DD, a day the calendar has), earlier or later; the kind never " +
    'changes. The date it has already changes nothing.',
  request: {
    params: targetParams,
    body: { required: true, content: { 'application/json': { schema: ChangeTargetDateRequestSchema } } },
  },
  responses: {
    200: json(TargetSchema, 'The target as it now is.'),
    400: json(
      TargetRefusalSchema,
      "The body did not validate (`invalid request`), or the date is not after the learner's today (`invalid target`, " +
        'reason `due_date`).',
    ),
    404: NO_TARGET,
    409: closed('its date cannot move'),
    ...learnerResponses,
    403: OWNER_ONLY,
  },
});

const endRoute = createRoute({
  method: 'post',
  path: '/targets/{id}/end',
  tags: ['targets'],
  summary: 'End a target before its date',
  description: 'Its words stay saved. Ending a target already ended changes nothing and also answers 204.',
  request: { params: targetParams },
  responses: {
    204: { description: 'The target is ended.' },
    404: NO_TARGET,
    409: json(ErrorSchema, "The target's date has come, so it is closed already. A target ended early answers 204."),
    ...learnerResponses,
    403: OWNER_ONLY,
  },
});

const addWordsRoute = createRoute({
  method: 'post',
  path: '/targets/{id}/words',
  tags: ['targets'],
  summary: 'Add words to a target',
  description:
    "Photo imports and typed words, saved into the enrollment's list as a new target saves them, and joined to the " +
    'target, in one transaction. A word the target holds already stays where it is. Something must be added.',
  request: {
    params: targetParams,
    body: { required: true, content: { 'application/json': { schema: AddTargetWordsRequestSchema } } },
  },
  responses: {
    200: json(TargetSchema, 'The target as it now is.'),
    400: json(
      TargetRefusalSchema,
      'The body did not validate or adds nothing (`invalid request`); a photo import is unknown or another list\'s ' +
        '(`invalid target`, reason `unknown_import`); or a typed word cannot be saved here (`invalid vocabulary entry`).',
    ),
    404: NO_TARGET,
    409: json(
      ErrorSchema,
      'The target is closed, so words cannot be added (`target closed`), or a photo import is not ready to save ' +
        '(`photo import not ready`).',
    ),
    ...learnerResponses,
    403: OWNER_ONLY,
  },
});

const removeWordRoute = createRoute({
  method: 'delete',
  path: '/targets/{id}/words/{gloss_id}',
  tags: ['targets'],
  summary: 'Take a word out of a target',
  description:
    'The word stays saved. Idempotent: a word the target does not hold also answers 204. Taking out the last word ' +
    'leaves an empty target.',
  request: { params: wordParams },
  responses: {
    204: { description: 'The word is not in the target.' },
    404: NO_TARGET,
    409: closed('a word cannot be taken out'),
    ...learnerResponses,
    403: OWNER_ONLY,
  },
});

// Transport only (ADR 0001 R1). Mounted at /api.
export function createTargetsRouter(targets: TargetService) {
  const router = new OpenAPIHono<ActorEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });

  router.openapi(listRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      return c.json(await targets.list(c.var.actor, id), 200);
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      throw error;
    }
  });

  router.openapi(createTargetRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      return c.json(await targets.create(c.var.actor, id, c.req.valid('json')), 201);
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      if (error instanceof InvalidTarget) return c.json({ error: 'invalid target', reason: error.reason }, 400);
      if (error instanceof PhotoImportNotFound) return c.json(UNKNOWN_IMPORT, 400);
      if (error instanceof InvalidVocabularyEntry) return c.json({ error: 'invalid vocabulary entry' }, 400);
      if (error instanceof PhotoImportConflict) return c.json({ error: 'photo import not ready' }, 409);
      throw error;
    }
  });

  router.openapi(getTargetRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      return c.json(await targets.getTarget(c.var.actor, id), 200);
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof TargetNotFound) return c.json({ error: 'target not found' }, 404);
      throw error;
    }
  });

  router.openapi(changeDateRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      return c.json(await targets.changeDate(c.var.actor, id, c.req.valid('json')), 200);
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof TargetNotFound) return c.json({ error: 'target not found' }, 404);
      if (error instanceof InvalidTarget) return c.json({ error: 'invalid target', reason: error.reason }, 400);
      if (error instanceof TargetClosed) return c.json({ error: 'target closed' }, 409);
      throw error;
    }
  });

  router.openapi(endRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      await targets.end(c.var.actor, id);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof TargetNotFound) return c.json({ error: 'target not found' }, 404);
      if (error instanceof TargetClosed) return c.json({ error: 'target closed' }, 409);
      throw error;
    }
  });

  router.openapi(addWordsRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      return c.json(await targets.addWords(c.var.actor, id, c.req.valid('json')), 200);
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof TargetNotFound) return c.json({ error: 'target not found' }, 404);
      if (error instanceof TargetClosed) return c.json({ error: 'target closed' }, 409);
      if (error instanceof PhotoImportNotFound) return c.json(UNKNOWN_IMPORT, 400);
      if (error instanceof InvalidVocabularyEntry) return c.json({ error: 'invalid vocabulary entry' }, 400);
      if (error instanceof PhotoImportConflict) return c.json({ error: 'photo import not ready' }, 409);
      throw error;
    }
  });

  router.openapi(removeWordRoute, async (c) => {
    const { id, gloss_id } = c.req.valid('param');
    try {
      await targets.removeWord(c.var.actor, id, gloss_id);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof TargetNotFound) return c.json({ error: 'target not found' }, 404);
      if (error instanceof TargetClosed) return c.json({ error: 'target closed' }, 409);
      throw error;
    }
  });

  return router;
}
