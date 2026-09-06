import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  ErrorSchema,
} from '@lang-tutor/core/api/schemas';
import type { NextStepResponse } from '@lang-tutor/core/api';

import {
  currentQuestion,
  missedQuestions,
  positionOf,
  sessionScore,
  type SessionRecord,
} from '../domain/session';
import { OptionOutOfRange, QuestionDesynced, SessionNotFound } from '../errors';
import type { SessionService } from '../services/sessions';
import { NextStepRequestSchema } from './schemas';

function buildNextStepResponse(sessionId: string, record: SessionRecord): NextStepResponse {
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
  description: 'Draws ten questions and returns the first one.',
  request: {
    body: { content: { 'application/json': { schema: CreateSessionRequestSchema } } },
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
    const { user_id } = c.req.valid('json');
    const { sessionId, record } = await sessions.startSession(user_id);
    return c.json(
      {
        session_id: sessionId,
        question: currentQuestion(record)!,
        position: positionOf(record),
      },
      200,
    );
  });

  router.post('/:id/next-step', async (c) => {
    const sessionId = c.req.param('id');
    const parsed = NextStepRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'invalid request' }, 400);

    try {
      const record = await sessions.submitAnswer(
        sessionId,
        parsed.data.question_id,
        parsed.data.option_index,
      );
      return c.json(buildNextStepResponse(sessionId, record));
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
