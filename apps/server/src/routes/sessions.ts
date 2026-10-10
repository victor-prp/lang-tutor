import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  CurrentSessionResponseSchema,
  ErrorSchema,
  JudgedAnswerRequestSchema,
  JudgedAnswerResponseSchema,
  NextStepRequestSchema,
  NextStepResponseSchema,
  SessionViewSchema,
  SkipSessionResponseSchema,
  SpeechAnswerRequestSchema,
  SpeechAnswerResponseSchema,
} from '@lang-tutor/core/api/schemas';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import type { ProgressChange } from '../domain/progress';
import {
  currentQuestion,
  missedQuestions,
  positionOf,
  sessionScore,
} from '../domain/session';
import {
  AccessDenied,
  AnswerKindMismatch,
  EnrollmentNotFound,
  InsufficientQuestions,
  LlmUnavailable,
  NoSavedWords,
  OptionOutOfRange,
  QuestionDesynced,
  SessionNotFound,
  SessionNotReady,
  SessionNotSkippable,
  SessionOpen,
} from '../errors';
import type { SessionResult, SessionService } from '../services/sessions';
import { forbidden, learnerResponses, type ActorEnv } from './actor';

const failure = (description: string) => ({
  content: { 'application/json': { schema: ErrorSchema } },
  description,
});

// Phase 29 (spec D13): practising is the list owner's alone.
const NOT_YOURS = forbidden("the enrollment, or the session's, is another learner's");

const progressItem = (change: ProgressChange) => ({
  gloss_id: change.glossId,
  form: change.form,
  translation: change.translation,
  level_before: change.levelBefore,
  level_after: change.levelAfter,
  raised: change.raised,
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
    "An enrollment's first session is drawn from the seed and is ready at once. Every later one is built from the enrollment's saved words: it starts `preparing`, and its questions are generated in the background. Its question types come from a plan: runs of three cards that climb from recognition to recall, a matching board in sessions of seven words or more, listening cards only when the request says `listening: true`, and speaking cards only when it says `speaking: true`. Read it with GET /sessions/{id}.",
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
    ...learnerResponses,
    403: NOT_YOURS,
  },
});

const getSessionRoute = createRoute({
  method: 'get',
  path: '/sessions/{id}',
  tags: ['sessions'],
  summary: 'Read a session',
  description:
    'Its status, position, and the current question while it is ready. A completed session also carries `progress`: each practised saved word with its level before and after. Serves resume and the poll.',
  request: { params: sessionIdParam },
  responses: {
    200: { content: { 'application/json': { schema: SessionViewSchema } }, description: 'The session.' },
    404: failure('No session has this id.'),
    ...learnerResponses,
    403: NOT_YOURS,
  },
});

const skipSessionRoute = createRoute({
  method: 'post',
  path: '/sessions/{id}/skip',
  tags: ['sessions'],
  summary: 'Skip a session',
  description:
    'Ends a preparing or ready session. The answers given before the skip count toward progress. Skipping a skipped session is a no-op.',
  request: { params: sessionIdParam },
  responses: {
    200: { content: { 'application/json': { schema: SkipSessionResponseSchema } }, description: 'The session is skipped.' },
    404: failure('No session has this id.'),
    409: failure('The session is completed or failed (`session_not_skippable`).'),
    ...learnerResponses,
    403: NOT_YOURS,
  },
});

const nextStepRoute = createRoute({
  method: 'post',
  path: '/sessions/{id}/next-step',
  tags: ['sessions'],
  summary: 'Answer the current question',
  description:
    'Records an answer and returns the next question, or the final score once all are answered. A `multiple_choice` or `reverse_choice` question is answered with `option_index`; a `typed_translation` question with `text`, where an empty text means the learner asked for the answer and is wrong. A speaking card is answered by voice through `/speech`, or here with `pass`: `skip` passes it (a read-aloud card takes only this), and `show_answer` gives up on a `say_translation` card, which is wrong. A `say_translation` card also takes `text`, answered as a typed card. Re-sending the same answer replays the same response. A `typed_meaning` card is answered only through `/judged-answer`.',
  request: {
    params: sessionIdParam,
    body: { required: true, content: { 'application/json': { schema: NextStepRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: NextStepResponseSchema } },
      description:
        'The answer was recorded. `complete: false` carries the next question; `complete: true` carries the score and the missed questions. The completing response also carries `progress`: each practised saved word with its level before and after, and the dimensions that rose.',
    },
    400: failure(
      'The request body did not validate, `option_index` is out of range, or the answer is not the kind its question takes (`text` for a choice, `option_index` for a typed question).',
    ),
    404: failure('No session has this id.'),
    409: failure(
      "`question_id` is not the session's current question, or the session is not ready (`session_not_ready`).",
    ),
    ...learnerResponses,
    403: NOT_YOURS,
  },
});

const speechRoute = createRoute({
  method: 'post',
  path: '/sessions/{id}/speech',
  tags: ['sessions'],
  summary: 'Answer the current speaking card by voice',
  description:
    'Takes one recorded attempt at the current `read_aloud` or `say_translation` card, as base64 audio (`audio/aac`, `audio/mp4` or `audio/webm`, at most 200 KB). The server transcribes it with a language model, which costs money on every call, and judges the transcript. `understood` and `alternative` record the answer and carry `next`, the next-step response. `unheard` records nothing: the card stays current and may be tried again. Re-sending an attempt that was recorded replays it without a model call.',
  request: {
    params: sessionIdParam,
    body: { required: true, content: { 'application/json': { schema: SpeechAnswerRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: SpeechAnswerResponseSchema } },
      description: 'The attempt was judged. `next` is present when the answer was recorded.',
    },
    400: failure('The request body did not validate, or the current card is not a speaking card.'),
    404: failure('No session has this id.'),
    409: failure("`question_id` is not the session's current question, or the session is not ready (`session_not_ready`)."),
    413: failure('The body is over 300 KB.'),
    502: failure('The transcription failed or timed out; the card may be tried again.'),
    ...learnerResponses,
    403: NOT_YOURS,
  },
});

const judgedAnswerRoute = createRoute({
  method: 'post',
  path: '/sessions/{id}/judged-answer',
  tags: ['sessions'],
  summary: 'Answer the current card that the server judges',
  description:
    'Takes the text answer to the current `typed_meaning` card. An empty text is judged by rule, and so is the stored meaning, the gloss key (the citation form the word list shows), or one of the stored alternatives of the card\'s rendering or of its gloss; any other text is judged by a language model, which costs money on every call. The answer is recorded with its verdict, and `next` is the next-step response. Re-sending an answer that was recorded replays it without a model call. A judged card takes no answer through `next-step`.',
  request: {
    params: sessionIdParam,
    body: { required: true, content: { 'application/json': { schema: JudgedAnswerRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: JudgedAnswerResponseSchema } },
      description: 'The answer was judged and recorded.',
    },
    400: failure('The request body did not validate, or the current card is not one the server judges.'),
    404: failure('No session has this id.'),
    409: failure("`question_id` is not the session's current question, or the session is not ready (`session_not_ready`)."),
    502: failure('The judge failed or timed out; nothing was recorded, and the answer may be sent again.'),
    ...learnerResponses,
    403: NOT_YOURS,
  },
});

const currentSessionRoute = createRoute({
  method: 'get',
  path: '/enrollments/{id}/sessions/current',
  tags: ['sessions'],
  summary: "An enrollment's current session",
  description:
    'The newest session while it is preparing, ready or failed; where the next one will come from; and how many glosses are saved.',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: CurrentSessionResponseSchema } },
      description: 'The home screen state.',
    },
    404: failure('No enrollment has this id.'),
    ...learnerResponses,
    403: NOT_YOURS,
  },
});

// Transport only: parse, validate, and map an outcome to a status code.
export function createSessionsRouter(sessions: SessionService) {
  // Without this hook the adapter's own 400 carries a Zod issue payload. The
  // contract says `{ error: 'invalid request' }`.
  const router = new OpenAPIHono<ActorEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });

  router.openapi(createSessionRoute, async (c) => {
    const { enrollment_id, listening, speaking } = c.req.valid('json');
    try {
      const created = await sessions.createNextSession(c.var.actor, enrollment_id, {
        listening: listening ?? false,
        speaking: speaking ?? false,
      });
      return c.json(
        { session_id: created.sessionId, status: created.status, source: created.source },
        201,
      );
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
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
      return c.json(sessionView(id, await sessions.getSession(c.var.actor, id)), 200);
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof SessionNotFound) return c.json({ error: 'session not found' }, 404);
      throw error;
    }
  });

  router.openapi(skipSessionRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      await sessions.skipSession(c.var.actor, id);
      return c.json({ session_id: id, status: 'skipped' as const }, 200);
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof SessionNotFound) return c.json({ error: 'session not found' }, 404);
      if (error instanceof SessionNotSkippable) return c.json({ error: 'session_not_skippable' }, 409);
      throw error;
    }
  });

  router.openapi(nextStepRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const answer =
      'text' in body ? { text: body.text } : 'pass' in body ? { pass: body.pass } : { option_index: body.option_index };
    try {
      const record = await sessions.submitAnswer(c.var.actor, id, body.question_id, answer);
      return c.json(buildNextStepResponse(id, record), 200);
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof SessionNotFound) return c.json({ error: 'session not found' }, 404);
      if (error instanceof SessionNotReady) return c.json({ error: 'session_not_ready' }, 409);
      if (error instanceof QuestionDesynced) {
        return c.json({ error: "question_id does not match the session's current question" }, 409);
      }
      if (error instanceof OptionOutOfRange) {
        return c.json({ error: 'option_index is out of range for this question' }, 400);
      }
      if (error instanceof AnswerKindMismatch) {
        return c.json({ error: 'the answer is not the kind this question takes' }, 400);
      }
      throw error; // anything else is a real failure: app.ts's onError makes it a 500
    }
  });

  // Phase 25 (spec D13). 270 000 characters of base64 and the JSON around them.
  router.use(
    '/sessions/:id/speech',
    bodyLimit({ maxSize: 300 * 1024, onError: (c) => c.json({ error: 'audio too large' }, 413) }),
  );

  router.openapi(speechRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    try {
      const result = await sessions.answerBySpeech(c.var.actor, id, {
        questionId: body.question_id,
        audio: body.audio,
        mimeType: body.mime_type,
      });
      return c.json(
        {
          heard: result.heard,
          verdict: result.verdict,
          ...(result.session ? { next: buildNextStepResponse(id, result.session) } : {}),
        },
        200,
      );
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof SessionNotFound) return c.json({ error: 'session not found' }, 404);
      if (error instanceof SessionNotReady) return c.json({ error: 'session_not_ready' }, 409);
      if (error instanceof QuestionDesynced) {
        return c.json({ error: "question_id does not match the session's current question" }, 409);
      }
      if (error instanceof AnswerKindMismatch) return c.json({ error: 'the current card is not a speaking card' }, 400);
      if (error instanceof LlmUnavailable) return c.json({ error: 'speech unavailable' }, 502);
      throw error;
    }
  });

  router.openapi(judgedAnswerRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    try {
      const result = await sessions.answerJudged(c.var.actor, id, { questionId: body.question_id, text: body.text });
      return c.json({ verdict: result.verdict, next: buildNextStepResponse(id, result.session) }, 200);
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof SessionNotFound) return c.json({ error: 'session not found' }, 404);
      if (error instanceof SessionNotReady) return c.json({ error: 'session_not_ready' }, 409);
      if (error instanceof QuestionDesynced) {
        return c.json({ error: "question_id does not match the session's current question" }, 409);
      }
      if (error instanceof AnswerKindMismatch) return c.json({ error: 'the current card is not judged by the server' }, 400);
      if (error instanceof LlmUnavailable) return c.json({ error: 'judge unavailable' }, 502);
      throw error;
    }
  });

  router.openapi(currentSessionRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      const { current, nextSource, savedCount } = await sessions.currentSession(c.var.actor, id);
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
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      throw error;
    }
  });

  return router;
}
