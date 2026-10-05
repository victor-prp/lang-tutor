import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  CurrentSessionResponseSchema,
  ErrorSchema,
  NextStepRequestSchema,
  NextStepResponseSchema,
  SessionViewSchema,
  SkipSessionResponseSchema,
} from '@lang-tutor/core/api/schemas';
import { z } from 'zod';

import type { ProgressChange } from '../domain/progress';
import {
  currentQuestion,
  missedQuestions,
  positionOf,
  sessionScore,
} from '../domain/session';
import {
  EnrollmentNotFound,
  InsufficientQuestions,
  NoSavedWords,
  OptionOutOfRange,
  QuestionDesynced,
  SessionNotFound,
  SessionNotReady,
  SessionNotSkippable,
  SessionOpen,
} from '../errors';
import type { SessionResult, SessionService } from '../services/sessions';

const failure = (description: string) => ({
  content: { 'application/json': { schema: ErrorSchema } },
  description,
});

const progressItem = (change: ProgressChange) => ({
  sense_id: change.senseId,
  form: change.form,
  translation: change.translation,
  level_before: change.levelBefore,
  level_after: change.levelAfter,
});

function buildNextStepResponse(
  sessionId: string,
  result: SessionResult,
): z.infer<typeof NextStepResponseSchema> {
  if (result.complete) {
    return {
      session_id: sessionId,
      question: null,
      position: positionOf(result),
      complete: true,
      score: sessionScore(result),
      missed_questions: missedQuestions(result),
      progress: result.progress.map(progressItem),
    };
  }
  return {
    session_id: sessionId,
    question: currentQuestion(result)!,
    position: positionOf(result),
    complete: false,
  };
}

function sessionView(sessionId: string, result: SessionResult): z.infer<typeof SessionViewSchema> {
  return {
    session_id: sessionId,
    status: result.status,
    source: result.source,
    position: positionOf(result),
    question: result.status === 'ready' ? (currentQuestion(result) ?? null) : null,
    progress: result.progress.map(progressItem),
  };
}

// `id` stays z.string() on every route below: an unknown id and a malformed one
// must both be 404s, which the repository decides (UUID_RE), not the router.
const sessionIdParam = z.object({ id: z.string() });

const createSessionRoute = createRoute({
  method: 'post',
  path: '/sessions',
  tags: ['sessions'],
  summary: 'Create the next session',
  description:
    "An enrollment's first session is drawn from the seed and is ready at once. Every later one is built from the enrollment's saved words: it starts `preparing`, and its questions are generated in the background. Read it with GET /sessions/{id}.",
  request: {
    body: { required: true, content: { 'application/json': { schema: CreateSessionRequestSchema } } },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: CreateSessionResponseSchema } },
      description: 'The session was created.',
    },
    400: failure('The request body did not validate.'),
    404: failure('No enrollment has this `enrollment_id`.'),
    409: failure(
      'An open session exists (`session_open`), the saved list is empty (`no_saved_words`), or the seed has too few questions for this pair (`not enough questions`).',
    ),
  },
});

const getSessionRoute = createRoute({
  method: 'get',
  path: '/sessions/{id}',
  tags: ['sessions'],
  summary: 'Read a session',
  description: 'Its status, progress, and the current question while it is ready. Serves resume and the poll.',
  request: { params: sessionIdParam },
  responses: {
    200: { content: { 'application/json': { schema: SessionViewSchema } }, description: 'The session.' },
    404: failure('No session has this id.'),
  },
});

const skipSessionRoute = createRoute({
  method: 'post',
  path: '/sessions/{id}/skip',
  tags: ['sessions'],
  summary: 'Skip a session',
  description: 'Ends a preparing or ready session. Skipping a skipped session is a no-op.',
  request: { params: sessionIdParam },
  responses: {
    200: { content: { 'application/json': { schema: SkipSessionResponseSchema } }, description: 'The session is skipped.' },
    404: failure('No session has this id.'),
    409: failure('The session is completed or failed (`session_not_skippable`).'),
  },
});

const nextStepRoute = createRoute({
  method: 'post',
  path: '/sessions/{id}/next-step',
  tags: ['sessions'],
  summary: 'Answer the current question',
  description:
    'Records an answer and returns the next question, or the final score once all are answered. Re-sending the same answer replays the same response.',
  request: {
    params: sessionIdParam,
    body: { required: true, content: { 'application/json': { schema: NextStepRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: NextStepResponseSchema } },
      description:
        'The answer was recorded. `complete: false` carries the next question; `complete: true` carries the score and the missed questions. The completing response also carries `progress`: each practised saved word with its level before and after.',
    },
    400: failure('The request body did not validate, or `option_index` is out of range.'),
    404: failure('No session has this id.'),
    409: failure(
      "`question_id` is not the session's current question, or the session is not ready (`session_not_ready`).",
    ),
  },
});

const currentSessionRoute = createRoute({
  method: 'get',
  path: '/enrollments/{id}/sessions/current',
  tags: ['sessions'],
  summary: "An enrollment's current session",
  description:
    'The newest session while it is preparing, ready or failed; where the next one will come from; and how many senses are saved.',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: CurrentSessionResponseSchema } },
      description: 'The home screen state.',
    },
    404: failure('No enrollment has this id.'),
  },
});

// Transport only: parse, validate, and map an outcome to a status code.
export function createSessionsRouter(sessions: SessionService) {
  // Without this hook the adapter's own 400 carries a Zod issue payload. The
  // contract says `{ error: 'invalid request' }`.
  const router = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });

  router.openapi(createSessionRoute, async (c) => {
    const { enrollment_id } = c.req.valid('json');
    try {
      const created = await sessions.createNextSession(enrollment_id);
      return c.json(
        { session_id: created.sessionId, status: created.status, source: created.source },
        201,
      );
    } catch (error) {
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      if (error instanceof SessionOpen) return c.json({ error: 'session_open' }, 409);
      if (error instanceof NoSavedWords) return c.json({ error: 'no_saved_words' }, 409);
      if (error instanceof InsufficientQuestions) return c.json({ error: 'not enough questions' }, 409);
      throw error;
    }
  });

  router.openapi(getSessionRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      return c.json(sessionView(id, await sessions.getSession(id)), 200);
    } catch (error) {
      if (error instanceof SessionNotFound) return c.json({ error: 'session not found' }, 404);
      throw error;
    }
  });

  router.openapi(skipSessionRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      await sessions.skipSession(id);
      return c.json({ session_id: id, status: 'skipped' as const }, 200);
    } catch (error) {
      if (error instanceof SessionNotFound) return c.json({ error: 'session not found' }, 404);
      if (error instanceof SessionNotSkippable) return c.json({ error: 'session_not_skippable' }, 409);
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
      if (error instanceof SessionNotReady) return c.json({ error: 'session_not_ready' }, 409);
      if (error instanceof QuestionDesynced) {
        return c.json({ error: "question_id does not match the session's current question" }, 409);
      }
      if (error instanceof OptionOutOfRange) {
        return c.json({ error: 'option_index is out of range for this question' }, 400);
      }
      throw error; // anything else is a real failure: app.ts's onError makes it a 500
    }
  });

  router.openapi(currentSessionRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      const { current, nextSource, savedCount } = await sessions.currentSession(id);
      return c.json(
        {
          current: current
            ? {
                session_id: current.id,
                status: current.status,
                source: current.source,
                answered: current.answered,
                total: current.total,
              }
            : null,
          next_source: nextSource,
          saved_count: savedCount,
        },
        200,
      );
    } catch (error) {
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      throw error;
    }
  });

  return router;
}
