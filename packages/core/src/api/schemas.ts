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
// 503 there is what distinguishes "server booting" from "broken". Since phase
// 15 it also answers "which server is this?" — several checkouts run at once,
// each on its own port and database, and a healthy port alone cannot tell them
// apart. The database is named, never the URL: the URL carries credentials.
export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  lane: z.string(),
  database: z.string(),
  port: z.number().int(),
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

// Three, not six: every correction that reaches the wire has been through
// `tidyAlternatives`, applied by the guards on the model path and again by
// `persistCorrection` on the write — so this cap is an invariant the SERVER
// holds rather than a hope about a third party, which is exactly the kind of cap
// a published contract should state. Applying it in only one of those two places
// would leave `dict:restore` free to violate it: the restore reaches the
// repository without passing through `domain/` at all.
//
// `alternatives` is REQUIRED and un-defaulted here, unlike on the model schema
// below. The asymmetry is the point: what a third party sends may be absent,
// what this server publishes may not be.
export const TranslationCorrectionSchema = z.object({
  corrected_form: z.string().min(1).max(100),
  alternatives: z.array(z.string().min(1).max(100)).max(3),
});

export const TranslationResponseSchema = z.object({
  // The string the learner typed, so the client can say "you typed thruot".
  text: z.string(),
  direction: TranslationDirectionSchema,
  // Both of these belong to the CORRECTED form when a correction is present, and
  // are byte-identical to what a direct lookup of it returns.
  kind: TranslationKindSchema,
  senses: z.array(TranslationSenseSchema).max(5),
  correction: TranslationCorrectionSchema.optional(),
});

// A closed set, because part_of_speech is half of dict_lexemes' unique key from
// phase 12 on: free text would make (book,"verb phrase") and (book,"verb_phrase")
// two lexemes, and the pre-phase-12 data already held 80 spellings of ten ideas.
// It is handed to Gemini inside responseSchema, so an eleventh is not expressible.
// Phrase classes collapse to their head: `kind` already records phrase-ness.
export const PartOfSpeechSchema = z.enum([
  'noun',
  'verb',
  'adjective',
  'adverb',
  'pronoun',
  'preposition',
  'conjunction',
  'determiner',
  'interjection',
  'numeral',
]);

// What the model is asked to return. Phase 10 made it a list of **entries**,
// because a string can be more than one word: `saw` is the verb `see` and the
// noun `saw`, and an earlier single-lemma shape could only ever answer one of
// them. Phase 12 made an entry a *lexeme* — a lemma AND a part of speech —
// because `booked` belongs to only one of `book`'s two. Deliberately still the
// response shape *minus* `text` and `direction`: both are decided in code before
// the call, so offering them to the model would only invite it to disagree with
// the server.
//
// `sense_code` goes on an extension rather than on TranslationSenseSchema, which
// is shared with the wire. It is model-supplied, and from phase 12 it is
// load-bearing rather than decorative: it is how a later form's translations are
// attached to senses the lexeme already has.
//
// `.omit` rather than a fresh object: part_of_speech moved up to the entry, and
// omitting it here is what makes a model that still puts one on a sense lose it
// on parse rather than smuggle it through.
export const LlmSenseSchema = TranslationSenseSchema.omit({ part_of_speech: true }).extend({
  sense_code: z.string().min(1).max(60),
});

// One entry per (lemma, part of speech) — a lexeme. min(1) on senses: an entry
// with no senses is meaningless, and a model returning one is malformed rather
// than empty — the empty answer is `entries: []`.
export const LlmEntrySchema = z.object({
  lemma: z.string().min(1),
  part_of_speech: PartOfSpeechSchema,
  senses: z.array(LlmSenseSchema).min(1).max(5),
});

// What the model reports, phase 13. Present only when the typed string is not a
// word or expression in either language but is near one or more that are.
export const LlmCorrectionSchema = z.object({
  // A surface form, not a lemma: `bokked` corrects to `booked`, never to `book`.
  // `.max(100)` is the request schema's own ceiling on learner text — this is the
  // one untrusted string that does not come through it, and it becomes a
  // dictionary key. `min(1)` because a correction without one is not a correction.
  corrected_form: z.string().min(1).max(100),
  // Other plausible intended forms, ranked, no senses. Tapping one is an ordinary
  // lookup that misses.
  //
  // `.optional()`, NOT a bare array — a bare array would be REQUIRED, and this
  // field must never be able to fail a good answer. `parseLlmTranslation` runs
  // `dropNulls` BEFORE `safeParse`, because phase 9 made absent and null mean the
  // same thing, so a provider answering `alternatives: null` — which is how
  // structured output spells "none" — has the key deleted and would then fail a
  // required field. The whole parse fails with it, and one decorative empty list
  // turns a correct translation into a 502. A provider that simply omits the
  // empty array lands in the same place. `.optional()` makes both spellings mean
  // "absent", and `tidyAlternatives` turns absent into `[]`.
  //
  // `.default([])` was the obvious spelling and is deliberately NOT used. Zod 4
  // emits a `"default": []` key into the JSON Schema; `toGeminiSchema` strips only
  // `$schema` and `additionalProperties`, so the key would travel to Gemini inside
  // `responseSchema`, and no schema here has ever sent it. A rejected
  // `responseSchema` is `LlmUnavailable('responded 400')` on EVERY translation
  // call — a total outage, from a field designed never to fail an answer.
  // (`z.toJSONSchema` also defaults to output mode, where a defaulted field is
  // REQUIRED, so `.default([])` would have told Gemini the key is mandatory too.)
  //
  // Six here against three on the wire: `maxItems` travels to Gemini either way,
  // but a provider that ignores it would, under `.max(3)`, fail the WHOLE parse on
  // one surplus alternative. Six is deliberately NOT tied to `entries`' cap, which
  // is five for a provider-side reason described there; this one is six because
  // doubling the wire's three leaves room for a surplus without failing an answer.
  //
  // The rule all of this follows: `correction` is decorative, so NOTHING about it
  // may fail an answer the model otherwise got right.
  alternatives: z.array(z.string().min(1).max(100)).max(6).optional(),
});

export const LlmTranslationSchema = z.object({
  kind: TranslationKindSchema,
  // Five, not three: `light` alone is noun, adjective and verb, and a
  // competing lemma still has to fit beside it.
  //
  // Five rather than six, and that ceiling is Gemini's rather than ours. This
  // schema travels as `responseSchema`, where array caps multiply: six entries
  // by five senses by a nested example object exceeded the provider's limit the
  // moment phase 13 added `correction`, and every translation call answered
  // `400 INVALID_ARGUMENT — the specified schema produces a constraint that has
  // too many states for serving`. Measured against the live API, not reasoned:
  // six entries fails with `correction` present and five succeeds, while
  // `senses` stays at five because READ_LIMIT and TranslationResponseSchema both
  // hold it there. No stub can catch this — MockServer accepts any
  // `responseSchema` without validating it — so only `npm run eval` or a real
  // lookup exercises it.
  //
  // When `correction` is present these describe `corrected_form`, not the typed
  // text — and so does `kind`, which the prompt's fourth rule is what actually
  // secures. `resolveKind` only clamps a single token; it cannot rule on a
  // multi-token corrected form.
  entries: z.array(LlmEntrySchema).max(5),
  correction: LlmCorrectionSchema.optional(),
});

// The second model call, phase 12. It exists because `sense_code` is invented
// per call: a lookup of `bank` names a sense river_bank and a later lookup of
// `banks` names the same sense river_edge, so matching stored senses on the code
// alone would duplicate the meaning silently. Deciding whether two glosses mean
// the same thing is a judgement, so the model makes it.

// One rendering of one stored sense for one new form. `translation: null` means
// the form does not admit that sense at all — adjectival `booked` has no
// record-a-charge reading — and the sense is then absent for this form.
export const LlmRenderingSchema = z.object({
  sense_code: z.string().min(1).max(60),
  translation: z.string().min(1).nullable(),
  example: z.object({ source: z.string().min(1), target: z.string().min(1) }).optional(),
});

export const LlmReconciliationSchema = z.object({
  // Ranked FOR THE QUERIED FORM. Stored codes reused where the meaning matches;
  // a new code only for a reading the stored list does not contain.
  senses: z.array(LlmRenderingSchema).max(5),
});
