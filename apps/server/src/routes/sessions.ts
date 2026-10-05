import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  ErrorSchema,
  NextStepRequestSchema,
  NextStepResponseSchema,
} from '@lang-tutor/core/api/schemas';
import { z } from 'zod';

import {
  currentQuestion,
  missedQuestions,
  positionOf,
  sessionScore,
  type SessionRecord,
} from '../domain/session';
import {
  EnrollmentNotFound,
  InsufficientQuestions,
  OptionOutOfRange,
  QuestionDesynced,
  SessionNotFound,
} from '../errors';
import type { SessionService } from '../services/sessions';

function buildNextStepResponse(
  sessionId: string,
  record: SessionRecord,
): z.infer<typeof NextStepResponseSchema> {
  if (record.complete) {
    return {
      session_id: sessionId,
      question: null,
      position: positionOf(record),
      complete: true,
      score: sessionScore(record),
      missed_questions: missedQuestions(record),
    };
  }
  return {
    session_id: sessionId,
    question: currentQuestion(record)!,
    position: positionOf(record),
    complete: false,
  };
}

const createSessionRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['sessions'],
  summary: 'Start a session',
  description: "Draws ten questions from the enrollment's language pair and returns the first one.",
  request: {
    body: { required: true, content: { 'application/json': { schema: CreateSessionRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: CreateSessionResponseSchema } },
      description: 'The session was created. `question` is its first question.',
    },
    400: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'The request body did not validate.',
    },
    404: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'No enrollment has this `enrollment_id`.',
    },
    409: {
      content: { 'application/json': { schema: ErrorSchema } },
      description:
        "The enrollment's language pair has fewer than ten questions, so no session can start.",
    },
  },
});

// `id` is `z.string()` and must stay that way. A `.uuid()` here would turn a
// malformed session id into a 400, and the contract — asserted by an existing
// route test — is that an unknown id and a malformed one both 404. The
// repository layer is what decides that, not the router.
const nextStepRoute = createRoute({
  method: 'post',
  path: '/{id}/next-step',
  tags: ['sessions'],
  summary: 'Answer the current question',
  description:
    'Records an answer and returns the next question, or the final score once ten are answered. Re-sending the same answer replays the same response.',
  request: {
    params: z.object({ id: z.string() }),
    body: { required: true, content: { 'application/json': { schema: NextStepRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: NextStepResponseSchema } },
      description:
        'The answer was recorded. `complete: false` carries the next question; `complete: true` carries the score and the missed questions.',
    },
    400: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'The request body did not validate, or `option_index` is out of range.',
    },
    404: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'No session has this id.',
    },
    409: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: "`question_id` is not the session's current question.",
    },
  },
});

// Transport only: parse, validate, and map an outcome to a status code. No SQL,
// no transaction, no knowledge that a database exists. The route definitions are
// also this API's published description — there is no second document to update.
export function createSessionsRouter(sessions: SessionService) {
  // Without this hook the adapter's own 400 carries a Zod issue payload. The
  // contract says `{ error: 'invalid request' }`, and this is the only thing
  // that keeps it saying so.
  const router = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });

  router.openapi(createSessionRoute, async (c) => {
    const { enrollment_id } = c.req.valid('json');
    try {
      const { sessionId } = await sessions.createNextSession(enrollment_id);
      const record = await sessions.getSession(sessionId);
      return c.json(
        {
          session_id: sessionId,
          question: currentQuestion(record)!,
          position: positionOf(record),
        },
        200,
      );
    } catch (error) {
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      if (error instanceof InsufficientQuestions) {
        return c.json({ error: 'not enough questions' }, 409);
      }
      throw error;
    }
  });

  router.openapi(nextStepRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { question_id, option_index } = c.req.valid('json');

    try {
      const record = await sessions.submitAnswer(id, question_id, option_index);
      return c.json(buildNextStepResponse(id, record), 200);
    } catch (error) {
      if (error instanceof SessionNotFound) return c.json({ error: 'session not found' }, 404);
      if (error instanceof QuestionDesynced) {
        return c.json({ error: "question_id does not match the session's current question" }, 409);
      }
      if (error instanceof OptionOutOfRange) {
        return c.json({ error: 'option_index is out of range for this question' }, 400);
      }
      throw error; // anything else is a real failure — app.ts's onError turns it into a 500
    }
  });

  return router;
}
