import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  CurrentSessionQuerySchema,
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
  StartSessionRequestSchema,
  StartSessionResponseSchema,
} from '@lang-tutor/core/api/schemas';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import type { ProgressChange } from '../domain/progress';
import {
  currentQuestion,
  missedQuestions,
  pendingRetryOf,
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
  TargetClosed,
  TargetNotFound,
  WrongScript,
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
  // Phase 34 (spec D9): while a card is held for its second try, it is the
  // current one, and the response says so.
  return {
    session_id: sessionId,
    question: currentQuestion(result)!,
    position: positionOf(result),
    complete: false,
    pending_retry: pendingRetryOf(result),
  };
}

function sessionView(sessionId: string, result: SessionResult): z.infer<typeof SessionViewSchema> {
  return {
    session_id: sessionId,
    status: result.status,
    source: result.source,
    position: positionOf(result),
    question: result.status === 'ready' ? (currentQuestion(result) ?? null) : null,
    pending_retry: result.status === 'ready' ? pendingRetryOf(result) : null,
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
  summary: 'The next session to play',
  description:
    "The session in stock, the one not yet started, when there is one: answered as it is, built for the device that asked first, so this request's `listening` and `speaking` do not change it. Otherwise one is created. An enrollment's first session is drawn from the seed and is ready at once. Every later one is built from the enrollment's saved words: it starts `preparing`, and its questions are generated in the background. Its question types come from a plan: runs of three cards that climb from recognition to recall, a matching board in sessions of seven words or more, listening cards only when the request says `listening: true`, and speaking cards only when it says `speaking: true`. Read it with GET /sessions/{id}. With `target_id`, the session is the target's (phase 57): it asks only that target's words, from what the target owes today, and has a stock and a started session of its own; without it, the main path's, which asks only saved words in no active target.",
  request: {
    body: { required: true, content: { 'application/json': { schema: CreateSessionRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: CreateSessionResponseSchema } },
      description: 'The session in stock, not yet started: the next one to play.',
    },
    201: {
      content: { 'application/json': { schema: CreateSessionResponseSchema } },
      description: 'The session was created.',
    },
    400: failure('The request body did not validate.'),
    404: failure('No enrollment has this `enrollment_id`, or it has no target with this `target_id` (`target not found`).'),
    409: failure(
      "A session of the path is started (`session_open`), which is continued rather than replaced, the path has nothing to ask (`no_saved_words`), the target's date has passed or it was ended (`target closed`), or the seed has too few questions for this pair (`not enough questions`).",
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
    'Its status, position, and the current question while it is ready. `pending_retry` is set while that question is held for its second try, so a resumed session opens on it. A completed session also carries `progress`: each practised saved word with its level before and after. Serves resume and the poll.',
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
    'Ends a preparing or ready session. The answers given before the skip count toward progress; a card held for its second try is given up first. Skipping a skipped session is a no-op.',
  request: { params: sessionIdParam },
  responses: {
    200: { content: { 'application/json': { schema: SkipSessionResponseSchema } }, description: 'The session is skipped.' },
    404: failure('No session has this id.'),
    409: failure('The session is completed or failed (`session_not_skippable`).'),
    ...learnerResponses,
    403: NOT_YOURS,
  },
});

const startSessionRoute = createRoute({
  method: 'post',
  path: '/sessions/{id}/start',
  tags: ['sessions'],
  summary: 'Start a session',
  description:
    "Marks a ready session started, and has the next session prepared in the background, built for this device: listening cards only when the request says `listening: true`, speaking cards only when it says `speaking: true`. Starting a started session is a no-op. A session's first answer starts it too, for a client that never sends this.",
  request: {
    params: sessionIdParam,
    body: { required: true, content: { 'application/json': { schema: StartSessionRequestSchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: StartSessionResponseSchema } }, description: 'The session is started.' },
    400: failure('The request body did not validate.'),
    404: failure('No session has this id.'),
    409: failure(
      'The session is not ready: preparing, completed, skipped or failed (`session_not_ready`), or another session of the enrollment is started (`session_open`).',
    ),
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
    'Records an answer and returns the next question, or the final score once all are answered. A `multiple_choice`, `new_meaning` or `reverse_choice` question is answered with `option_index`; a `typed_translation` question with `text`, where an empty text means the learner asked for the answer and is wrong. A speaking card is answered by voice through `/speech`, or here with `pass`: `skip` passes it (a read-aloud card takes only this), and `show_answer` gives up on a `say_translation` card, which is wrong. A `meet` card, a new word shown before it is asked, is ungraded and is answered with `seen: true` and nothing else: it records that the learner saw it, counts in no score, and takes no `retry`. A `say_translation` card also takes `text`, answered as a typed card. Re-sending the same answer replays the same response. A `typed_meaning` card is answered only through `/judged-answer`. An answer that is right but is not the saved word (`alternative`) on a `typed_translation`, `say_translation` or `cloze_typed` card holds the card for one second try: the response carries the same card as `question`, with `pending_retry`, and the session does not move on or complete until the same card is answered again with `retry: true`, judged as the first answer was. An empty text, or a `pass` (`show_answer` or `skip`), with `retry: true` gives up. Without `retry`, an answer to the held card replays the first one. A first `text` answer to a `cloze_typed` card may carry `hint_opened`, whether the learner opened its Hebrew sentence; it is stored with the answer and ignored on every other card and on a retry. Such an answer may also carry `check_fit: true`: when its text is not one of the card\'s accepted words, the server asks a language model, which costs money on every call, whether it fills the gap, and records one that does as `alternative`, holding the card for its second try; a failed call records it `wrong`. `check_fit` is ignored on every other card, on a retry and on a replay.',
  request: {
    params: sessionIdParam,
    body: { required: true, content: { 'application/json': { schema: NextStepRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: NextStepResponseSchema } },
      description:
        'The answer was recorded. `complete: false` carries the next question, or the card held for its second try with `pending_retry` set; `complete: true` carries the score and the missed questions. The completing response also carries `progress`: each practised saved word with its level before and after, and the dimensions that rose.',
    },
    400: failure(
      'The request body did not validate, `option_index` is out of range, or the answer is not the kind its question takes (`text` for a choice, `option_index` for a typed question).',
    ),
    404: failure('No session has this id.'),
    409: failure(
      "`question_id` is not the session's current question, `retry` was sent where no second try is pending, the session is not ready (`session_not_ready`), or another session of the enrollment is started, so this one cannot start (`session_open`).",
    ),
    422: failure("The text has letters but none in its answer language's alphabet. Nothing was recorded and the card stays current."),
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
    'Takes one recorded attempt at the current `read_aloud` or `say_translation` card, as base64 audio (`audio/aac`, `audio/mp4` or `audio/webm`, at most 200 KB). The server transcribes it with a language model, which costs money on every call, and judges the transcript. `understood` and `alternative` record the answer and carry `next`, the next-step response. `unheard` records nothing: the card stays current and may be tried again. Re-sending an attempt that was recorded replays it without a model call. An `alternative` on a `say_translation` card holds the card for one second try (`next.pending_retry`): a clip sent with `retry: true` is that try, transcribed and judged as the first, and one sent without it replays the first.',
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
    409: failure("`question_id` is not the session's current question, `retry` was sent where no second try is pending, the session is not ready (`session_not_ready`), or another session of the enrollment is started, so this one cannot start (`session_open`)."),
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
    'Takes the text answer to the current `typed_meaning` card. An empty text is judged by rule, and so is the stored meaning, the gloss key (the citation form the word list shows), or one of the stored alternatives of the card\'s rendering or of its gloss; any other text is judged by a language model, which costs money on every call. The answer is recorded with its verdict, and `next` is the next-step response. Re-sending an answer that was recorded replays it without a model call. A judged card takes no answer through `next-step`. An `alternative` (another sense of a `typed_meaning` card, another word in a `sentence_translation`) holds the card for one second try (`next.pending_retry`): a text sent with `retry: true` is that try, judged as the first, and an empty one gives up, answered `wrong`; one sent without it replays the first.',
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
    409: failure("`question_id` is not the session's current question, `retry` was sent where no second try is pending, the session is not ready (`session_not_ready`), or another session of the enrollment is started, so this one cannot start (`session_open`)."),
    422: failure("The text has letters but none in its answer language's alphabet. Nothing was recorded, no model was called, and the card stays current."),
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
    "Of one path (phase 57): the main path's, or with `target_id` the target's. Its started session, else the one in stock (not yet started: preparing or ready), else its newest session if it failed; where the next one will come from; how many glosses are saved; and how many of the path's words wait (`due_count`): on the main path those due for review, on a target's those with work owed today.",
  request: { params: z.object({ id: z.string() }), query: CurrentSessionQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: CurrentSessionResponseSchema } },
      description: 'The home screen state.',
    },
    400: failure('The query did not validate.'),
    404: failure('No enrollment has this id, or it has no target with this `target_id` (`target not found`).'),
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
    const { enrollment_id, listening, speaking, target_id } = c.req.valid('json');
    try {
      const next = await sessions.createNextSession(
        c.var.actor,
        enrollment_id,
        { listening: listening ?? false, speaking: speaking ?? false },
        target_id ?? null,
      );
      const body = { session_id: next.sessionId, status: next.status, source: next.source };
      // Phase 43 (spec D5): the stock is answered, not created.
      return next.created ? c.json(body, 201) : c.json(body, 200);
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      if (error instanceof TargetNotFound) return c.json({ error: 'target not found' }, 404);
      if (error instanceof SessionOpen) return c.json({ error: 'session_open' }, 409);
      if (error instanceof TargetClosed) return c.json({ error: 'target closed' }, 409);
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

  router.openapi(startSessionRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { listening, speaking } = c.req.valid('json');
    try {
      const started = await sessions.startSession(c.var.actor, id, { listening: listening ?? false, speaking: speaking ?? false });
      return c.json({ session_id: started.sessionId, status: started.status }, 200);
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof SessionNotFound) return c.json({ error: 'session not found' }, 404);
      if (error instanceof SessionNotReady) return c.json({ error: 'session_not_ready' }, 409);
      if (error instanceof SessionOpen) return c.json({ error: 'session_open' }, 409);
      throw error;
    }
  });

  router.openapi(nextStepRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    try {
      // Phase 41 (spec D2): a text answer may ask for a fit check, which answerText makes.
      const record =
        'text' in body
          ? await sessions.answerText(c.var.actor, id, {
              questionId: body.question_id,
              text: body.text,
              hintOpened: body.hint_opened,
              helped: body.helped,
              checkFit: body.check_fit,
              retry: body.retry ?? false,
            })
          : await sessions.submitAnswer(
              c.var.actor,
              id,
              body.question_id,
              // Phase 54 (spec D6). A meet card's `seen` has no second try.
              // Phase 56 (spec D5): a pass after help is recorded helped.
              'seen' in body
                ? { seen: true }
                : 'pass' in body
                  ? body.helped === undefined
                    ? { pass: body.pass }
                    : { pass: body.pass, helped: body.helped }
                  : { option_index: body.option_index },
              { retry: 'seen' in body ? false : body.retry ?? false },
            );
      return c.json(buildNextStepResponse(id, record), 200);
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof SessionNotFound) return c.json({ error: 'session not found' }, 404);
      if (error instanceof SessionNotReady) return c.json({ error: 'session_not_ready' }, 409);
      // Phase 43 (spec D2): this answer would start a second session.
      if (error instanceof SessionOpen) return c.json({ error: 'session_open' }, 409);
      if (error instanceof QuestionDesynced) {
        return c.json({ error: "question_id does not match the session's current question" }, 409);
      }
      if (error instanceof OptionOutOfRange) {
        return c.json({ error: 'option_index is out of range for this question' }, 400);
      }
      if (error instanceof AnswerKindMismatch) {
        return c.json({ error: 'the answer is not the kind this question takes' }, 400);
      }
      if (error instanceof WrongScript) return c.json({ error: `the answer is not written in ${error.language}'s alphabet` }, 422);
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
        retry: body.retry ?? false,
        helped: body.helped,
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
      // Phase 43 (spec D2): this answer would start a second session.
      if (error instanceof SessionOpen) return c.json({ error: 'session_open' }, 409);
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
      const result = await sessions.answerJudged(c.var.actor, id, {
        questionId: body.question_id,
        text: body.text,
        retry: body.retry ?? false,
        helped: body.helped,
        tapped: body.tapped,
      });
      return c.json({ verdict: result.verdict, next: buildNextStepResponse(id, result.session) }, 200);
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof SessionNotFound) return c.json({ error: 'session not found' }, 404);
      if (error instanceof SessionNotReady) return c.json({ error: 'session_not_ready' }, 409);
      // Phase 43 (spec D2): this answer would start a second session.
      if (error instanceof SessionOpen) return c.json({ error: 'session_open' }, 409);
      if (error instanceof QuestionDesynced) {
        return c.json({ error: "question_id does not match the session's current question" }, 409);
      }
      if (error instanceof AnswerKindMismatch) return c.json({ error: 'the current card is not judged by the server' }, 400);
      if (error instanceof WrongScript) return c.json({ error: `the answer is not written in ${error.language}'s alphabet` }, 422);
      if (error instanceof LlmUnavailable) return c.json({ error: 'judge unavailable' }, 502);
      throw error;
    }
  });

  router.openapi(currentSessionRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { target_id } = c.req.valid('query');
    try {
      const { current, nextSource, savedCount, dueCount } = await sessions.currentSession(c.var.actor, id, target_id ?? null);
      return c.json(
        {
          current: current
            ? {
                session_id: current.id,
                status: current.status,
                source: current.source,
                answered: current.answered,
                total: current.total,
                started: current.started,
              }
            : null,
          next_source: nextSource,
          saved_count: savedCount,
          due_count: dueCount,
        },
        200,
      );
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      if (error instanceof TargetNotFound) return c.json({ error: 'target not found' }, 404);
      throw error;
    }
  });

  return router;
}
