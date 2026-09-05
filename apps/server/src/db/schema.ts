import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/** One element of `questions.options`. snake_case: it is stored data, not a TS-only shape. */
export type QuestionOption = { position: number; text: string; is_correct: boolean };

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  nativeLanguage: varchar('native_language', { length: 10 }).notNull().default('he'),
  targetLanguage: varchar('target_language', { length: 10 }).notNull().default('en'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const vocabTerms = pgTable(
  'vocab_terms',
  {
    id: text('id').primaryKey(),
    languageCode: varchar('language_code', { length: 10 }).notNull(),
    lemma: text('lemma').notNull(),
    partOfSpeech: varchar('part_of_speech', { length: 50 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('vocab_terms_language_lemma_key').on(t.languageCode, t.lemma)],
);

export const termVariants = pgTable(
  'term_variants',
  {
    id: text('id').primaryKey(),
    termId: text('term_id')
      .notNull()
      .references(() => vocabTerms.id, { onDelete: 'cascade' }),
    form: text('form').notNull(),
    kind: text('kind').notNull(),
  },
  (t) => [unique('term_variants_term_form_key').on(t.termId, t.form)],
);

export const vocabTermSenses = pgTable('vocab_term_senses', {
  id: text('id').primaryKey(),
  termId: text('term_id')
    .notNull()
    .references(() => vocabTerms.id, { onDelete: 'cascade' }),
  senseCode: text('sense_code').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const termSenseTranslations = pgTable(
  'term_sense_translations',
  {
    senseId: text('sense_id')
      .notNull()
      .references(() => vocabTermSenses.id, { onDelete: 'cascade' }),
    userLanguageCode: varchar('user_language_code', { length: 10 }).notNull(),
    translation: text('translation').notNull(),
    definitionNotes: text('definition_notes'),
  },
  (t) => [primaryKey({ columns: [t.senseId, t.userLanguageCode] })],
);

export const questions = pgTable(
  'questions',
  {
    id: text('id').primaryKey(),
    // Nullable: NULL means shared. Phase 4 writes only shared rows; a later
    // phase writes per-learner ones without a migration.
    userId: text('user_id').references(() => users.id),
    senseId: text('sense_id')
      .notNull()
      .references(() => vocabTermSenses.id),
    promptVariantId: text('prompt_variant_id')
      .notNull()
      .references(() => termVariants.id),
    targetLanguage: varchar('target_language', { length: 10 }).notNull(),
    userLanguageCode: varchar('user_language_code', { length: 10 }).notNull(),
    type: varchar('type', { length: 50 }).notNull(),
    options: jsonb('options').$type<QuestionOption[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('questions_options_valid', sql`question_options_valid(${t.options})`)],
);

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // NULL = in progress. There is no separate `complete` column.
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export const sessionQuestions = pgTable(
  'session_questions',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    questionId: text('question_id')
      .notNull()
      .references(() => questions.id),
    // The per-session shuffle: option_order[i] is the canonical position of the
    // option shown at display index i.
    optionOrder: integer('option_order').array().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.position] }),
    // Exists purely as the composite FK target for `answers`.
    unique('session_questions_position_question_key').on(t.sessionId, t.position, t.questionId),
  ],
);

export const answers = pgTable(
  'answers',
  {
    sessionId: uuid('session_id').notNull(),
    position: integer('position').notNull(),
    questionId: text('question_id').notNull(),
    selectedOptionPosition: integer('selected_option_position').notNull(),
    answeredAt: timestamp('answered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.position] }),
    // Makes it impossible to record an answer to a question that was not in
    // this session at this position.
    foreignKey({
      columns: [t.sessionId, t.position, t.questionId],
      foreignColumns: [
        sessionQuestions.sessionId,
        sessionQuestions.position,
        sessionQuestions.questionId,
      ],
    }).onDelete('cascade'),
    check('answers_selected_option_position_nonneg', sql`${t.selectedOptionPosition} >= 0`),
  ],
);
