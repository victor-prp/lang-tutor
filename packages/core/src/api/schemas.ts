import { z } from 'zod';

// The wire contract, defined once. `apps/server` attaches OpenAPI metadata to
// these in createRoute; `apps/mobile` never sees this file, only the types
// inferred from it in ./types. Plain Zod 4 on purpose: core must not depend on
// a Hono adapter, and Zod 4's native JSON Schema output is what lets the
// adapter document these without one.
// Today's card: the target word, four meanings in the learner's language.
export const MultipleChoiceQuestionSchema = z.object({
  id: z.string(),
  type: z.literal('multiple_choice'),
  vocab_term_id: z.string(),
  question: z.string(),
  options: z.array(z.string()),
  correct_option: z.number().int(),
});

// Phase 23. The same card turned round: the meaning, four target words.
// `part_of_speech` disambiguates a Hebrew prompt (ספר is a book or "counted").
export const ReverseChoiceQuestionSchema = z.object({
  id: z.string(),
  type: z.literal('reverse_choice'),
  vocab_term_id: z.string(),
  question: z.string(),
  part_of_speech: z.string(),
  options: z.array(z.string()),
  correct_option: z.number().int(),
});

// Phase 23. The meaning; the learner types the target word. The client holds
// what it needs to judge locally, as it holds `correct_option` on a choice: the
// saved form, its lemma, and other words the model said are also right.
export const TypedTranslationQuestionSchema = z.object({
  id: z.string(),
  type: z.literal('typed_translation'),
  vocab_term_id: z.string(),
  question: z.string(),
  part_of_speech: z.string(),
  answer: z.string(),
  lemma: z.string(),
  alternatives: z.array(z.string()),
});

// Phase 24. Hear the word, pick its meaning: today's card with its prompt
// spoken rather than shown. `question` is the form the app speaks, and shows
// once the card is answered (spec D6).
export const ListenChoiceQuestionSchema = z.object({
  id: z.string(),
  type: z.literal('listen_choice'),
  vocab_term_id: z.string(),
  question: z.string(),
  options: z.array(z.string()),
  correct_option: z.number().int(),
});

// Phase 24. Hear the word, type it. Judged against the spoken form alone
// (spec D7). `meaning` is shown after the answer and read by the missed list.
export const DictationQuestionSchema = z.object({
  id: z.string(),
  type: z.literal('dictation'),
  vocab_term_id: z.string(),
  question: z.string(),
  meaning: z.string(),
});

// Phase 24 (spec D10). A matching board, as each of its words carries it: every
// word's question id, the word, and its right option among the shared options.
export const MatchingBoardSchema = z.object({
  question_ids: z.array(z.string()),
  words: z.array(z.string()),
  correct_options: z.array(z.number().int()),
});

// Phase 24. One word of a board. A board is consecutive questions of this type,
// each answered by its first-tried meaning. `options` are the board's five
// meanings, in the one order all its words share.
export const MatchingQuestionSchema = z.object({
  id: z.string(),
  type: z.literal('matching'),
  vocab_term_id: z.string(),
  question: z.string(),
  options: z.array(z.string()),
  correct_option: z.number().int(),
  board: MatchingBoardSchema,
});

// Phase 24 (spec D11). The meaning; the learner builds the word from `tiles`,
// its letters and two more, shuffled. `answer` is the form, for the local judge.
export const LetterTilesQuestionSchema = z.object({
  id: z.string(),
  type: z.literal('letter_tiles'),
  vocab_term_id: z.string(),
  question: z.string(),
  part_of_speech: z.string(),
  answer: z.string(),
  tiles: z.array(z.string()),
});

// A tagged union. Consumers switch on `type`, so adding a type is additive and
// the compiler finds every switch that has not learnt it.
export const QuestionSchema = z.discriminatedUnion('type', [
  MultipleChoiceQuestionSchema,
  ReverseChoiceQuestionSchema,
  TypedTranslationQuestionSchema,
  ListenChoiceQuestionSchema,
  DictationQuestionSchema,
  MatchingQuestionSchema,
  LetterTilesQuestionSchema,
]);

// Phase 23. How a typed answer was judged (spec D5). Every verdict but `wrong`
// counts in the score.
export const TypedVerdictSchema = z.enum(['exact', 'near_miss', 'alternative', 'wrong']);

// Scoring reads `is_correct` and nothing else, so any question type satisfies
// it. `answer_string` is the audit-log field: the chosen option's text rather
// than its index, because option order is shuffled per session, or the text
// typed.
export const AnswerRecordSchema = z.object({
  question_id: z.string(),
  is_correct: z.boolean(),
  answer_string: z.string(),
  // Phase 23. Present for a typed answer only.
  verdict: TypedVerdictSchema.optional(),
});

export const ScoreSchema = z.object({
  correct: z.number().int(),
  total: z.number().int(),
});

// Phase 20. Knowledge per saved sense: five dimensions, each with a level from
// 1 to 5 that only rises. packages/core/src/domain/progress.ts holds the same
// list as DIMENSIONS, and a test keeps the two equal.
export const KnowledgeDimensionSchema = z.enum([
  'written_receptive',
  'written_productive',
  'spoken_receptive',
  'spoken_productive',
  'spelling',
]);

export const LevelSchema = z.number().int().min(1).max(5);

// A saved sense's badge and its five levels. Only a saved sense has one.
export const SenseProgressSchema = z.object({
  level: LevelSchema,
  dimensions: z.object({
    written_receptive: LevelSchema,
    written_productive: LevelSchema,
    spoken_receptive: LevelSchema,
    spoken_productive: LevelSchema,
    spelling: LevelSchema,
  }),
});

// One practised saved sense on the results screen. Both levels are badges over
// the live dimensions. `form` is the prompt the learner saw; `translation` is
// the right answer.
export const SessionProgressItemSchema = z.object({
  sense_id: z.string(),
  form: z.string(),
  translation: z.string(),
  level_before: LevelSchema,
  level_after: LevelSchema,
  // Phase 23. The live dimensions that rose in this session, in DIMENSIONS
  // order. A word can move a dimension without moving its badge.
  raised: z.array(KnowledgeDimensionSchema),
});

// Phase 19. A session's lifecycle: preparing → ready → completed, or skipped /
// failed. "In progress" is not a status: it is `ready` with answers.
export const SessionStatusSchema = z.enum(['preparing', 'ready', 'completed', 'skipped', 'failed']);

// Where a session's questions came from: the shared seed, or the enrollment's
// saved senses.
export const SessionSourceSchema = z.enum(['seed', 'list']);

export const MissedQuestionSchema = z.object({
  question: QuestionSchema,
  correct_answer: z.string(),
});

export const PositionSchema = z.object({
  position: z.number().int(),
  total: z.number().int(),
});

export const CreateSessionRequestSchema = z.object({
  enrollment_id: z.string().min(1),
});

// Phase 19. Creating a session no longer returns its first question: a list
// session has none until its job has run. The app reads the session instead.
export const CreateSessionResponseSchema = z.object({
  session_id: z.string(),
  status: SessionStatusSchema,
  source: SessionSourceSchema,
});

// Phase 19. One session as resume and the poll read it. `question` is the
// current one while the session is ready and unfinished, and null otherwise.
export const SessionViewSchema = z.object({
  session_id: z.string(),
  status: SessionStatusSchema,
  source: SessionSourceSchema,
  position: PositionSchema,
  question: QuestionSchema.nullable(),
  // Phase 20. What a completed session did to the saved words; empty otherwise.
  progress: z.array(SessionProgressItemSchema),
});

// Phase 23. A choice is answered by index, a typed card by its text. Empty
// text is "show me the answer", which is wrong.
export const NextStepRequestSchema = z.union([
  z.object({
    user_id: z.string().min(1),
    question_id: z.string().min(1),
    option_index: z.number().int().nonnegative(),
  }),
  z.object({
    user_id: z.string().min(1),
    question_id: z.string().min(1),
    text: z.string().max(100),
  }),
]);

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
    // Phase 20. Every practised saved sense, with its badge before and after.
    progress: z.array(SessionProgressItemSchema),
  }),
]);

// Phase 19. The home screen's one read. `current` is the enrollment's newest
// session when it is preparing, ready or failed (never completed or skipped).
// `total` is how many questions it holds, so 0 while preparing.
export const CurrentSessionSchema = z.object({
  session_id: z.string(),
  status: SessionStatusSchema,
  source: SessionSourceSchema,
  answered: z.number().int(),
  total: z.number().int(),
});

export const CurrentSessionResponseSchema = z.object({
  current: CurrentSessionSchema.nullable(),
  next_source: SessionSourceSchema,
  saved_count: z.number().int(),
});

export const SkipSessionResponseSchema = z.object({
  session_id: z.string(),
  status: z.literal('skipped'),
});

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

// Every language the server knows. Request fields narrow to it; response fields
// stay plain strings (see UserSchema below).
export const LanguageCodeSchema = z.enum(['he', 'en', 'ru', 'it']);

// What a learner may name as their native language at sign-up. Russian (phase
// 16) and Italian (phase 22) are targets only.
export const NativeLanguageSchema = z.enum(['he', 'en']);

// Phase 16's restriction, published rather than hidden: the app's UI is Hebrew
// only, so every new enrollment is explained in Hebrew. Widening this enum is
// non-breaking for every client that shipped before it.
export const EnrollmentSourceSchema = z.enum(['he']);

// A response shape, so the language fields are plain strings: they are read from
// a varchar(10) column, and narrowing them here would turn a future third
// language into a validation failure inside clients that shipped before it.
export const UserSchema = z.object({
  id: z.string(),
  username: z.string(),
  display_name: z.string(),
  age: z.number().int(),
  native_language: z.string(),
});

export const CreateUserRequestSchema = z.object({
  username: UsernameSchema,
  display_name: z.string().min(1).max(60),
  age: z.number().int().min(3).max(120),
  native_language: NativeLanguageSchema,
});

// A course of study: one target language, explained in one source language.
// Language fields are plain strings for the reason UserSchema's are.
export const EnrollmentSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  source_language: z.string(),
  target_language: z.string(),
  created_at: z.string(),
});

export const EnrollmentListSchema = z.array(EnrollmentSchema);

export const CreateEnrollmentRequestSchema = z
  .object({
    source_language: EnrollmentSourceSchema,
    target_language: LanguageCodeSchema,
  })
  .refine((request) => request.source_language !== request.target_language, {
    message: 'source and target language must differ',
  });

export const LoginRequestSchema = z.object({
  username: UsernameSchema,
});

// Phase 16. Why an input came back empty without a model call: the script
// guard (apps/server/src/domain/languages.ts) found its letters in `to`'s
// script, or in neither language's.
export const TranslationGuardReasonSchema = z.enum(['wrong_direction', 'out_of_pair']);

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
  // Phase 18. The dictionary rows this sense was served from, so a client can
  // save it. Optional because two answers have none: a sentence is never
  // stored, and a word whose write failed is still answered, with 200, from the
  // model's reply.
  sense_id: z.string().optional(),
  variant_id: z.string().optional(),
  // Present only when the request named an enrollment AND `from` is that
  // enrollment's target language AND the sense has ids. Absent means "cannot be
  // saved here", never "not saved".
  saved: z.boolean().optional(),
});

export const TranslationRequestSchema = z
  .object({
    // Trimmed before length is judged, so "   " is empty rather than three chars.
    // The 100-character ceiling is also the cap on how much untrusted text can
    // reach the model in one call.
    text: z.string().trim().min(1).max(100),
    // Phase 16. Always stated by the client: there is no detection. The client
    // reads the pair from the learner's active enrollment.
    from: LanguageCodeSchema,
    to: LanguageCodeSchema,
    // Phase 18. When present, the response marks which senses this enrollment
    // has saved, and it is used for nothing else. This reverses phase 16's "the
    // endpoint never learns who asked" — deliberately, and only for `saved`.
    enrollment_id: z.string().min(1).optional(),
  })
  // Every supported pair includes Hebrew: {he,en}, {he,ru} and {he,it}. A pair
  // without Hebrew, en↔ru for one, is refused here, before the model is ever
  // called.
  .refine(({ from, to }) => from !== to && (from === 'he' || to === 'he'), {
    message: 'unsupported language pair',
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
  // Echoed as plain strings, for the reason UserSchema's language fields are.
  from: z.string(),
  to: z.string(),
  // Both of these belong to the CORRECTED form when a correction is present, and
  // are byte-identical to what a direct lookup of it returns.
  kind: TranslationKindSchema,
  senses: z.array(TranslationSenseSchema).max(5),
  correction: TranslationCorrectionSchema.optional(),
  // Present only when the script guard emptied `senses` without a model call.
  reason: TranslationGuardReasonSchema.optional(),
});

// Phase 18 — an enrollment's word list. One entry per (enrollment, sense); the
// form it was first saved from travels with it, because a sense has no wording
// of its own.
export const VocabularyEntryInputSchema = z.object({
  sense_id: z.string().min(1),
  variant_id: z.string().min(1),
});

// One card and save-all are the same call. Twenty is four lookups' worth of
// senses, since a lookup answers with at most five.
export const SaveVocabularyRequestSchema = z.object({
  entries: z.array(VocabularyEntryInputSchema).min(1).max(20),
});

// Every sense of the request, saved now or already: saving is idempotent.
export const SaveVocabularyResponseSchema = z.object({
  saved_sense_ids: z.array(z.string()),
});

// Query-string values arrive as strings, hence coerce. A cursor is opaque: the
// server decodes it and answers 400 when it cannot.
export const VocabularyPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
  // Phase 20. One level only.
  level: z.coerce.number().int().min(1).max(5).optional(),
});

// Phase 21: one row per lemma. `headline` is the lowest-ranked saved sense, in
// the wording of the form it was saved from; `parts_of_speech` are its saved
// senses' parts of speech, distinct and ascending; `sense_count` counts the senses
// of every lexeme with the lemma that have some rendering in the enrollment's
// source language — what the drill-down can show.
export const VocabularyWordSchema = z.object({
  lemma: z.string(),
  parts_of_speech: z.array(z.string()),
  headline: z.object({ sense_id: z.string(), translation: z.string(), form: z.string() }),
  saved_count: z.number().int(),
  sense_count: z.number().int(),
  // Phase 20. The word's badge: the rounded mean over its saved senses and the live dimensions.
  level: LevelSchema,
});

export const VocabularyPageSchema = z.object({
  items: z.array(VocabularyWordSchema),
  next_cursor: z.string().nullable(),
});

// One sense in the drill-down. `variant_id` and `form` name the rendering shown:
// the saved form for a saved sense, a representative one otherwise. Saving from
// the drill-down records that variant.
export const VocabularySenseSchema = z.object({
  sense_id: z.string(),
  variant_id: z.string(),
  form: z.string(),
  translation: z.string(),
  // Phase 21. The detail spans every lexeme of a lemma, so each sense names its own.
  part_of_speech: z.string(),
  example: z.object({ source: z.string(), target: z.string() }).optional(),
  saved: z.boolean(),
  // Phase 20. Present on a saved sense only: its badge and five levels.
  progress: SenseProgressSchema.optional(),
});

// Phase 21. One word is every lexeme with this lemma in the enrollment's target
// language.
export const VocabularyWordDetailSchema = z.object({
  lemma: z.string(),
  // Phase 20. The word's badge, as on the list; null when nothing is saved.
  level: LevelSchema.nullable(),
  senses: z.array(VocabularySenseSchema),
});

// Phase 21. A query parameter rather than a path segment: a lemma may hold a
// space or a slash. Matched exactly. U+0000 is refused here: Hono decodes %00 into
// the string, and Postgres raises on a NUL in a text parameter, which would be a 500.
export const VocabularyWordQuerySchema = z.object({
  lemma: z.string().min(1).regex(/^[^\u0000]*$/),
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
// response shape *minus* `text`, `from` and `to`: all three are fixed in code
// before the call, so offering them to the model would only invite it to
// disagree with the server.
//
// `sense_code` goes on an extension rather than on TranslationSenseSchema, which
// is shared with the wire. It is model-supplied, and from phase 12 it is
// load-bearing rather than decorative: it is how a later form's translations are
// attached to senses the lexeme already has.
//
// `.omit` rather than a fresh object: part_of_speech moved up to the entry, and
// omitting it here is what makes a model that still puts one on a sense lose it
// on parse rather than smuggle it through.
export const LlmSenseSchema = TranslationSenseSchema.omit({
  part_of_speech: true,
  // Phase 18's wire-only fields. The model neither knows nor may invent them,
  // and every property here travels to Gemini inside responseSchema.
  sense_id: true,
  variant_id: true,
  saved: true,
}).extend({
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

// Phase 19. The model's answer when asked for a session's wrong options. `key`
// is echoed from the request (q1, q2, …) rather than a sense id: a short key is
// one the model cannot mistype.
//
// Phase 23. Three tasks share the call (spec D8). A choice item has three
// `distractors` and a typed item none, so the count is the domain's check, not
// the schema's. `alternatives` (other right answers for a typed item) is
// optional and capped at twice the five kept, for the reason
// LlmTranslationSchema.alternatives gives: a missing or surplus list must never
// fail a session the model otherwise answered.
export const LlmDistractorsSchema = z.object({
  items: z
    .array(
      z.object({
        key: z.string(),
        distractors: z.array(z.string()).max(3),
        alternatives: z.array(z.string()).max(10).optional(),
      }),
    )
    .max(10),
});
