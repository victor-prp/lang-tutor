import type { CreateSessionResponse, NextStepResponse, Question } from '@lang-tutor/core/api';
import { Hono } from 'hono';

import {
  currentQuestion,
  missedQuestions,
  newSessionRecord,
  positionOf,
  sessionScore,
  step,
  type SessionRecord,
} from '../session';
import type { SessionStore } from '../store/sessionStore';
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

export function createSessionsRouter(store: SessionStore, questionPool: readonly Question[]) {
  const router = new Hono();

  router.post('/', async (c) => {
    const parsed = CreateSessionRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'invalid request' }, 400);

    const record = newSessionRecord(parsed.data.user_id, questionPool);
    const sessionId = store.insert(record);
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

    const record = store.get(sessionId);
    if (!record) return c.json({ error: 'session not found' }, 404);

    const outcome = step(record, parsed.data.question_id, parsed.data.option_index);
    if (outcome.status === 'invalid_question') {
      return c.json({ error: "question_id does not match the session's current question" }, 409);
    }

    let updated = outcome.record;
    if (outcome.status === 'advanced') {
      if (outcome.justCompleted) {
        updated = { ...updated, completed_at: Date.now() };
        // The one place a completed session is logged — exactly once, since a
        // retried next-step for an already-complete session takes the
        // 'replayed' branch above and never reaches here again.
        console.log(
          JSON.stringify({
            session_id: sessionId,
            user_id: updated.user_id,
            questions: updated.questions,
            answers: updated.answers,
            score: sessionScore(updated),
          }),
        );
      }
      store.set(sessionId, updated);
    }

    return c.json(buildNextStepResponse(sessionId, updated));
  });

  return router;
}
