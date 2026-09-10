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

// Identity, phase 8. A username identifies a learner; it authenticates nothing.
// Lowercase ASCII so it is unambiguous to type on an RTL keyboard, in a URL,
// and in a test. The display name carries the Hebrew.
export const UsernameSchema = z.string().regex(/^[a-z0-9_]{3,30}$/);

// The pair this app supports today. Narrow on the way in only — see UserSchema.
export const LanguageCodeSchema = z.enum(['he', 'en']);

// A response shape, so the language fields are plain strings: they are read from
// a varchar(10) column, and narrowing them here would turn a future third
// language into a validation failure inside clients that shipped before it.
export const UserSchema = z.object({
  id: z.string(),
  username: z.string(),
  display_name: z.string(),
  age: z.number().int(),
  native_language: z.string(),
  target_language: z.string(),
});

// No .refine() for native !== target. The server's OpenAPI adapter converts
// this to JSON Schema, which cannot express a cross-field rule; the service
// raises InvalidLanguagePair and a database CHECK is the backstop.
export const CreateUserRequestSchema = z.object({
  username: UsernameSchema,
  display_name: z.string().min(1).max(60),
  age: z.number().int().min(3).max(120),
  native_language: LanguageCodeSchema,
  target_language: LanguageCodeSchema,
});

export const LoginRequestSchema = z.object({
  username: UsernameSchema,
});

// Translation, phase 9. Two directions only; a third language would need more
// than an enum entry, so narrowing here is honest rather than limiting.
export const TranslationDirectionSchema = z.enum(['en_he', 'he_en']);

// Describes the input, not a meaning, so it sits at the top level of the
// response. `word` is decided in code for a single token; the model answers the
// phrase/sentence distinction, which no token count can settle.
export const TranslationKindSchema = z.enum(['word', 'phrase', 'sentence']);

// `part_of_speech` and `example` are optional because a sentence has neither: a
// part of speech classifies a lexical item, and an example restates an input
// that is already a sentence. Optional rather than empty strings keeps "none"
// distinguishable from "the model forgot".
export const TranslationSenseSchema = z.object({
  translation: z.string().min(1),
  part_of_speech: z.string().optional(),
  example: z.object({ source: z.string().min(1), target: z.string().min(1) }).optional(),
});

export const TranslationRequestSchema = z.object({
  // Trimmed before length is judged, so "   " is empty rather than three chars.
  // The 100-character ceiling is also the cap on how much untrusted text can
  // reach the model in one call.
  text: z.string().trim().min(1).max(100),
  // Absent means "detect from the script". Present only when the learner taps
  // the flip control, so a wrong detection is recoverable.
  direction: TranslationDirectionSchema.optional(),
});

export const TranslationResponseSchema = z.object({
  text: z.string(),
  direction: TranslationDirectionSchema,
  kind: TranslationKindSchema,
  senses: z.array(TranslationSenseSchema).max(5),
});

// What the model is asked to return. Phase 10 made it a list of **entries**,
// because a string can be more than one word: `saw` is the verb `see` and the
// noun `saw`, and an earlier single-lemma shape could only ever answer one of
// them. Deliberately still the response shape *minus* `text` and `direction`:
// both are decided in code before the call, so offering them to the model would
// only invite it to disagree with the server.
//
// `sense_code` goes on an extension rather than on TranslationSenseSchema,
// which is shared with the wire. It is model-supplied, has no functional role —
// senses are never merged within a term — and exists so a row reads as
// financial_institution rather than s0 during a play-test.
export const LlmSenseSchema = TranslationSenseSchema.extend({
  sense_code: z.string().min(1).max(60),
});

// min(1): an entry with no senses is meaningless, and a model returning one is
// malformed rather than empty — the empty answer is `entries: []`.
export const LlmEntrySchema = z.object({
  lemma: z.string().min(1),
  senses: z.array(LlmSenseSchema).min(1).max(5),
});

export const LlmTranslationSchema = z.object({
  kind: TranslationKindSchema,
  // Ranked: the likeliest reading of the typed form first. Most strings have
  // one entry, so the typical answer is the size phase 9 already returned.
  entries: z.array(LlmEntrySchema).max(3),
});
