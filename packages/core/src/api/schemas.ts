import { z } from 'zod';

// The wire contract, defined once. `apps/server` attaches OpenAPI metadata to
// these in createRoute; `apps/mobile` never sees this file, only the types
// inferred from it in ./types. Plain Zod 4 on purpose: core must not depend on
// a Hono adapter, and Zod 4's native JSON Schema output is what lets the
// adapter document these without one.
export const MultipleChoiceQuestionSchema = z.object({
  id: z.string(),
  type: z.literal('multiple_choice'),
  vocab_term_id: z.string(),
  question: z.string(),
  options: z.array(z.string()),
  correct_option: z.number().int(),
});

// A tagged union with one member today. The `type` field exists from day one so
// consumers switch on it; adding a question type is then additive.
export const QuestionSchema = MultipleChoiceQuestionSchema;

// Scoring reads `is_correct` and nothing else, so any future question type
// satisfies it. `answer_string` is the audit-log field: text rather than an
// option index, because option order is shuffled per session.
export const AnswerRecordSchema = z.object({
  question_id: z.string(),
  is_correct: z.boolean(),
  answer_string: z.string(),
});

export const ScoreSchema = z.object({
  correct: z.number().int(),
  total: z.number().int(),
});

export const MissedQuestionSchema = z.object({
  question: QuestionSchema,
  correct_answer: z.string(),
});

export const PositionSchema = z.object({
  position: z.number().int(),
  total: z.number().int(),
});

export const CreateSessionRequestSchema = z.object({
  user_id: z.string().min(1),
});

export const CreateSessionResponseSchema = z.object({
  session_id: z.string(),
  question: QuestionSchema,
  position: PositionSchema,
});

export const NextStepRequestSchema = z.object({
  user_id: z.string().min(1),
  question_id: z.string().min(1),
  option_index: z.number().int().nonnegative(),
});

// A discriminated union on `complete`: when true, the caller has everything
// the Results screen needs (score, missed_questions) in this same response —
// there is no separate results call.
export const NextStepResponseSchema = z.discriminatedUnion('complete', [
  z.object({
    session_id: z.string(),
    question: QuestionSchema,
    position: PositionSchema,
    complete: z.literal(false),
  }),
  z.object({
    session_id: z.string(),
    question: z.null(),
    position: PositionSchema,
    complete: z.literal(true),
    score: ScoreSchema,
    missed_questions: z.array(MissedQuestionSchema),
  }),
]);

// The failure body every endpoint can return. Until this phase this shape lived
// only inside handler code; declaring it here is what lets each route publish
// its failures instead of documenting a happy path.
export const ErrorSchema = z.object({
  error: z.string(),
});

// /health is part of the wire contract too: the e2e suite waits on it, and a
// 503 there is what distinguishes "server booting" from "broken".
export const HealthResponseSchema = z.object({
  ok: z.boolean(),
});
