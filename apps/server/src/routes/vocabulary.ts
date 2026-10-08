import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  ErrorSchema,
  SaveVocabularyRequestSchema,
  SaveVocabularyResponseSchema,
  VocabularyPageQuerySchema,
  VocabularyPageSchema,
  VocabularyWordDetailSchema,
  VocabularyWordQuerySchema,
} from '@lang-tutor/core/api/schemas';
import { z } from 'zod';

import { AccessDenied, EnrollmentNotFound, InvalidCursor, InvalidVocabularyEntry, WordNotFound } from '../errors';
import type { VocabularyService } from '../services/vocabulary';
import { learnerResponses, type ActorEnv } from './actor';

const BASE = '/enrollments/{id}/vocabulary';
const enrollmentParams = z.object({ id: z.string() });
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});
const NOT_ENROLLED = json(ErrorSchema, 'No enrollment has this id.');

const saveRoute = createRoute({
  method: 'post',
  path: BASE,
  tags: ['vocabulary'],
  summary: "Save senses to an enrollment's word list",
  description:
    'One entry per sense. Each item names the sense and the form (variant) it was saved from; ' +
    'saving a sense that is already saved keeps its first form and is not an error. The batch is ' +
    'all-or-nothing.',
  request: {
    params: enrollmentParams,
    body: { required: true, content: { 'application/json': { schema: SaveVocabularyRequestSchema } } },
  },
  responses: {
    200: json(SaveVocabularyResponseSchema, 'Every sense of the request is now saved.'),
    400: json(
      ErrorSchema,
      'The body did not validate, or an item cannot be saved here: its sense is not in the ' +
        "enrollment's target language, or its form does not render it in the source language.",
    ),
    404: NOT_ENROLLED,
    ...learnerResponses,
  },
});

const listRoute = createRoute({
  method: 'get',
  path: BASE,
  tags: ['vocabulary'],
  summary: "List an enrollment's words",
  description:
    'One item per word: every lexeme with the same lemma is one word, with one level over all its ' +
    'saved senses. Ordered newest save first; `level` keeps one level only. Keyset-paginated: pass ' +
    '`next_cursor` back as `cursor`. A word saved into again moves to the top and is never served ' +
    'twice in one walk.',
  request: { params: enrollmentParams, query: VocabularyPageQuerySchema },
  responses: {
    200: json(VocabularyPageSchema, 'One page; `next_cursor` is null on the last.'),
    400: json(
      ErrorSchema,
      '`limit` is outside 1–100, `level` is not one of the published values, or `cursor` was not issued by this server.',
    ),
    404: NOT_ENROLLED,
    ...learnerResponses,
  },
});

const unsaveRoute = createRoute({
  method: 'delete',
  path: `${BASE}/senses/{sense_id}`,
  tags: ['vocabulary'],
  summary: 'Unsave a sense',
  description: 'Idempotent: unsaving a sense that is not saved also answers 204.',
  request: { params: z.object({ id: z.string(), sense_id: z.string() }) },
  responses: {
    204: { description: 'The sense is not saved.' },
    404: NOT_ENROLLED,
    ...learnerResponses,
  },
});

const detailRoute = createRoute({
  method: 'get',
  path: `${BASE}/word`,
  tags: ['vocabulary'],
  summary: 'One word, with every sense it can show',
  description:
    "A word is every lexeme with this lemma in the enrollment's target language; the lemma is " +
    'matched exactly. Every sense of those lexemes that has a rendering in the source language is ' +
    'listed with its part of speech, saved senses first, then by part of speech. A saved sense is ' +
    'shown in the form it was saved from and carries its level in each knowledge dimension; the ' +
    'word carries its overall level, null when nothing is saved.',
  request: { params: enrollmentParams, query: VocabularyWordQuerySchema },
  responses: {
    200: json(VocabularyWordDetailSchema, 'The word, possibly with nothing saved.'),
    400: json(ErrorSchema, '`lemma` is missing or empty.'),
    404: json(
      ErrorSchema,
      "No enrollment has this id, or no word with this lemma is in the enrollment's target language.",
    ),
    ...learnerResponses,
  },
});

// Transport only (ADR 0001 R1). Mounted at /api.
export function createVocabularyRouter(vocabulary: VocabularyService) {
  const router = new OpenAPIHono<ActorEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });

  router.openapi(saveRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { entries } = c.req.valid('json');
    try {
      return c.json(await vocabulary.save(c.var.actor, id, entries), 200);
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      if (error instanceof InvalidVocabularyEntry) {
        return c.json({ error: 'invalid vocabulary entry' }, 400);
      }
      throw error;
    }
  });

  router.openapi(listRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      return c.json(await vocabulary.listWords(id, c.req.valid('query')), 200);
    } catch (error) {
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      if (error instanceof InvalidCursor) return c.json({ error: 'invalid request' }, 400);
      throw error;
    }
  });

  router.openapi(unsaveRoute, async (c) => {
    const { id, sense_id } = c.req.valid('param');
    try {
      await vocabulary.unsave(c.var.actor, id, sense_id);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      throw error;
    }
  });

  router.openapi(detailRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { lemma } = c.req.valid('query');
    try {
      return c.json(await vocabulary.wordDetail(id, lemma), 200);
    } catch (error) {
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      if (error instanceof WordNotFound) return c.json({ error: 'word not found' }, 404);
      throw error;
    }
  });

  return router;
}
