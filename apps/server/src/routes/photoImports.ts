import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  ErrorSchema,
  PhotoImportCreateRequestSchema,
  PhotoImportItemSchema,
  PhotoImportItemUpdateSchema,
  PhotoImportListSchema,
  PhotoImportSchema,
  PhotoImportSummarySchema,
  SaveVocabularyResponseSchema,
} from '@lang-tutor/core/api/schemas';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import {
  EnrollmentNotFound,
  InvalidPhotoImportItem,
  InvalidVocabularyEntry,
  PhotoImportConflict,
  PhotoImportNotFound,
} from '../errors';
import type { PhotoImportService } from '../services/photoImports';
import { learnerResponses, type ActorEnv } from './actor';

/** Spec D6: the upload has a body limit, the second, after the speech upload's. A 2 MB
 *  JPEG is about 2.7 MB of base64 inside its JSON. */
export const PHOTO_BODY_LIMIT_BYTES = 3 * 1024 * 1024;

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});
const enrollmentParams = z.object({ id: z.string() });
const importParams = z.object({ id: z.string() });
const itemParams = z.object({ id: z.string(), position: z.coerce.number().int().nonnegative().max(2_147_483_647) });
const NO_IMPORT = json(ErrorSchema, 'No photo import has this id.');
const CONFLICT = json(ErrorSchema, 'The import is in the wrong state: a row still being looked up, or an import already saved or discarded.');

const createImportRoute = createRoute({
  method: 'post',
  path: '/enrollments/{id}/photo-imports',
  tags: ['photo-imports'],
  summary: 'Upload a photo of a word list',
  description:
    'Stores the photo and starts reading it in the background. Poll GET /photo-imports/{id} until its ' +
    'status is ready or failed. The photo is kept only until it is read.',
  request: {
    params: enrollmentParams,
    body: { required: true, content: { 'application/json': { schema: PhotoImportCreateRequestSchema } } },
  },
  responses: {
    202: json(PhotoImportSummarySchema, 'The import exists and is reading.'),
    400: json(ErrorSchema, 'The body did not validate: a JPEG as base64, at most 2 800 000 characters.'),
    404: json(ErrorSchema, 'No enrollment has this id.'),
    413: json(ErrorSchema, 'The body is over 3 MB.'),
    ...learnerResponses,
  },
});

const listImportsRoute = createRoute({
  method: 'get',
  path: '/enrollments/{id}/photo-imports',
  tags: ['photo-imports'],
  summary: "An enrollment's open photo imports",
  description: 'Not saved, not discarded, and less than 14 days old. Newest first.',
  request: { params: enrollmentParams },
  responses: {
    200: json(PhotoImportListSchema, 'The open imports, possibly none.'),
    404: json(ErrorSchema, 'No enrollment has this id.'),
    ...learnerResponses,
  },
});

const getImportRoute = createRoute({
  method: 'get',
  path: '/photo-imports/{id}',
  tags: ['photo-imports'],
  summary: 'One photo import with its rows',
  request: { params: importParams },
  responses: {
    200: json(PhotoImportSchema, 'The import and its rows, in page order.'),
    404: NO_IMPORT,
    ...learnerResponses,
  },
});

const updateItemRoute = createRoute({
  method: 'patch',
  path: '/photo-imports/{id}/items/{position}',
  tags: ['photo-imports'],
  summary: "Tick, untick or change a row's sense",
  request: {
    params: itemParams,
    body: { required: true, content: { 'application/json': { schema: PhotoImportItemUpdateSchema } } },
  },
  responses: {
    200: json(PhotoImportItemSchema, 'The row as it now is.'),
    400: json(ErrorSchema, "The body did not validate, the sense is not one of the row's options, or the row has none to tick."),
    404: json(ErrorSchema, 'No photo import has this id, or it has no such row.'),
    409: CONFLICT,
    ...learnerResponses,
  },
});

const saveImportRoute = createRoute({
  method: 'post',
  path: '/photo-imports/{id}/save',
  tags: ['photo-imports'],
  summary: "Save the ticked rows' senses",
  description:
    "All or nothing, in one transaction, and the import becomes saved. Saving a saved import answers the same ids and writes nothing.",
  request: { params: importParams },
  responses: {
    200: json(SaveVocabularyResponseSchema, 'Every ticked sense is now saved.'),
    400: json(ErrorSchema, 'A sense cannot be saved in this enrollment.'),
    404: NO_IMPORT,
    409: json(ErrorSchema, 'The import is not ready: still reading or looking up, failed, or discarded.'),
    ...learnerResponses,
  },
});

const discardImportRoute = createRoute({
  method: 'post',
  path: '/photo-imports/{id}/discard',
  tags: ['photo-imports'],
  summary: 'Discard a photo import without saving',
  description: 'Idempotent on a discarded import. Its remaining lookups are skipped.',
  request: { params: importParams },
  responses: {
    204: { description: 'The import is discarded.' },
    404: NO_IMPORT,
    409: json(ErrorSchema, 'The import was already saved.'),
    ...learnerResponses,
  },
});

// Transport only (ADR 0001 R1). Mounted at /api.
export function createPhotoImportsRouter(photoImports: PhotoImportService) {
  const router = new OpenAPIHono<ActorEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });

  router.use(
    '/enrollments/:id/photo-imports',
    bodyLimit({ maxSize: PHOTO_BODY_LIMIT_BYTES, onError: (c) => c.json({ error: 'photo too large' }, 413) }),
  );

  router.openapi(createImportRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      return c.json(await photoImports.create(id, c.req.valid('json')), 202);
    } catch (error) {
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      throw error;
    }
  });

  router.openapi(listImportsRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      return c.json(await photoImports.list(id), 200);
    } catch (error) {
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      throw error;
    }
  });

  router.openapi(getImportRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      return c.json(await photoImports.getImport(id), 200);
    } catch (error) {
      if (error instanceof PhotoImportNotFound) return c.json({ error: 'photo import not found' }, 404);
      throw error;
    }
  });

  router.openapi(updateItemRoute, async (c) => {
    const { id, position } = c.req.valid('param');
    try {
      return c.json(await photoImports.updateItem(id, position, c.req.valid('json')), 200);
    } catch (error) {
      if (error instanceof PhotoImportNotFound) return c.json({ error: 'photo import not found' }, 404);
      if (error instanceof InvalidPhotoImportItem) return c.json({ error: 'invalid row change' }, 400);
      if (error instanceof PhotoImportConflict) return c.json({ error: 'photo import conflict' }, 409);
      throw error;
    }
  });

  router.openapi(saveImportRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      return c.json(await photoImports.save(id), 200);
    } catch (error) {
      if (error instanceof PhotoImportNotFound) return c.json({ error: 'photo import not found' }, 404);
      if (error instanceof InvalidVocabularyEntry) return c.json({ error: 'invalid vocabulary entry' }, 400);
      if (error instanceof PhotoImportConflict) return c.json({ error: 'photo import conflict' }, 409);
      throw error;
    }
  });

  router.openapi(discardImportRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      await photoImports.discard(id);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof PhotoImportNotFound) return c.json({ error: 'photo import not found' }, 404);
      if (error instanceof PhotoImportConflict) return c.json({ error: 'photo import conflict' }, 409);
      throw error;
    }
  });

  return router;
}
