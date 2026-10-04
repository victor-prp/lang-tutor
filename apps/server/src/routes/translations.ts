import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  ErrorSchema,
  TranslationRequestSchema,
  TranslationResponseSchema,
} from '@lang-tutor/core/api/schemas';

import {
  EnrollmentNotFound,
  LlmUnavailable,
  PairNotEnrolled,
  TranslationUnreadable,
} from '../errors';
import type { Logger } from '../logger';
import type { TranslationService } from '../services/translations';

const translateRoute = createRoute({
  method: 'post',
  path: '/translations',
  tags: ['translations'],
  summary: 'Translate a word, phrase or sentence',
  description:
    'Returns every sense in one response, ranked with the most common first, so a client ' +
    'can show them all without a second request. An input that is not a word or ' +
    'expression yields 200 with an empty `senses` array — that is an answer, not a failure. ' +
    'The client states the direction with `from` and `to`; supported pairs are Hebrew with ' +
    'English and Hebrew with Russian, either way. ' +
    "Optionally names the learner's `enrollment_id`; the response then marks, on a lookup " +
    "from the enrollment's target language, which senses that enrollment has `saved`. The " +
    'enrollment is used only for that. ' +
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
        'The translation. `from` and `to` echo the request; `kind` describes the input. A ' +
        '`sentence` carries exactly one sense, with no part of speech and no example. An empty ' +
        '`senses` array with a `reason` means the input was refused before any model call: ' +
        "`wrong_direction` when its letters are in `to`'s script, `out_of_pair` when they are in " +
        "neither language's.",
    },
    400: {
      content: { 'application/json': { schema: ErrorSchema } },
      description:
        'The request body did not validate, or `enrollment_id` names an enrollment whose pair is not `from`/`to`.',
    },
    404: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'No enrollment has the given `enrollment_id`.',
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
export function createTranslationsRouter(translations: TranslationService, logger: Logger) {
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
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      if (error instanceof PairNotEnrolled) return c.json({ error: 'pair not enrolled' }, 400);
      // Two errors, one status: the learner can do nothing different about
      // either. Which one it was lives in the log, as `cause` — never in the
      // response, so the wire contract stays one message for both.
      if (error instanceof LlmUnavailable || error instanceof TranslationUnreadable) {
        logger.error('translation unavailable', error);
        return c.json({ error: 'translation unavailable' }, 502);
      }
      throw error; // app.ts's onError turns anything else into a 500
    }
  });

  return router;
}
