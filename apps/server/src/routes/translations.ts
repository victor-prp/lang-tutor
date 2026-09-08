import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  ErrorSchema,
  TranslationRequestSchema,
  TranslationResponseSchema,
} from '@lang-tutor/core/api/schemas';

import { LlmUnavailable, TranslationUnreadable } from '../errors';
import type { TranslationService } from '../services/translations';

const translateRoute = createRoute({
  method: 'post',
  path: '/translations',
  tags: ['translations'],
  summary: 'Translate a word, phrase or sentence',
  description:
    'Returns every sense in one response, ranked with the most common first, so a client ' +
    'can reveal the rest without a second request. An input that is not a word or ' +
    'expression yields 200 with an empty `senses` array — that is an answer, not a failure. ' +
    'NOTE: this endpoint calls a paid third-party model on every request and there is no ' +
    'rate limit in front of it.',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: TranslationRequestSchema } },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: TranslationResponseSchema } },
      description:
        'The translation. `direction` is what the server detected, or the override that was ' +
        'sent; `kind` describes the input. A `sentence` carries exactly one sense, with no ' +
        'part of speech and no example.',
    },
    400: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'The request body did not validate.',
    },
    502: {
      content: { 'application/json': { schema: ErrorSchema } },
      description:
        'The language model could not be reached, refused the request, ran out of time, or ' +
        'answered with something that did not match the expected shape.',
    },
  },
});

// Transport only: parse, validate, map an outcome to a status code. Mounted at
// /api, so this publishes as /api/translations.
export function createTranslationsRouter(translations: TranslationService) {
  // Without this hook the adapter's own 400 carries a Zod issue payload; the
  // contract says { error: 'invalid request' } (ADR 0003 R7).
  const router = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });

  router.openapi(translateRoute, async (c) => {
    const input = c.req.valid('json');
    try {
      return c.json(await translations.translate(input), 200);
    } catch (error) {
      // Two errors, one status: the learner can do nothing different about
      // either. Which one it was lives in the log, where the operator needs it.
      if (error instanceof LlmUnavailable || error instanceof TranslationUnreadable) {
        return c.json({ error: 'translation unavailable' }, 502);
      }
      throw error; // app.ts's onError turns anything else into a 500
    }
  });

  return router;
}
