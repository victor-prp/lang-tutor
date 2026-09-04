import type { CreateSessionResponse, NextStepResponse } from '@lang-tutor/core/api';
import { Hono } from 'hono';

import {
  currentQuestion,
  missedQuestions,
  positionOf,
  sessionScore,
  type SessionRecord,
} from '../domain/session';
import { OptionOutOfRange, QuestionDesynced, SessionNotFound } from '../errors';
import type { SessionService } from '../services/sessions';
import { CreateSessionRequestSchema, NextStepRequestSchema } from './schemas';

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

// Transport only: parse, validate, and map an outcome to a status code. No SQL,
// no transaction, no knowledge that a database exists.
export function createSessionsRouter(sessions: SessionService) {
  const router = new Hono();

  router.post('/', async (c) => {
    const parsed = CreateSessionRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'invalid request' }, 400);

    const { sessionId, record } = await sessions.startSession(parsed.data.user_id);
    const response: CreateSessionResponse = {
      session_id: sessionId,
      question: currentQuestion(record)!,
      position: positionOf(record),
    };
    return c.json(response);
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
