import type { PhotoImportOption } from '@lang-tutor/core/api';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/** One element of `questions.options`. snake_case: it is stored data, not a TS-only shape. */
export type QuestionOption = { position: number; text: string; is_correct: boolean };

const tz = { withTimezone: true } as const;

/**
 * Phase 29 (spec D8). Better Auth's four models, renamed to this repo's
 * convention, plus our send log. Better Auth writes the first four through its
 * Drizzle adapter (auth/betterAuth.ts); our code writes only auth_code_sends
 * and the claim command's email update (repo/auth.ts). ADR 0009 R2.
 */
export const authUsers = pgTable('auth_users', {
  id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
});

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    expiresAt: timestamp('expires_at', tz).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
  },
  (t) => [index('auth_sessions_user_id_idx').on(t.userId)],
);

export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', tz),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', tz),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [index('auth_accounts_user_id_idx').on(t.userId)],
);

export const authVerifications = pgTable(
  'auth_verifications',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', tz).notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [index('auth_verifications_identifier_idx').on(t.identifier)],
);

/** Phase 29 (spec D4). One row per code the provider accepted. */
export const authCodeSends = pgTable(
  'auth_code_sends',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    email: text('email').notNull(),
    sentAt: timestamp('sent_at', tz).notNull().defaultNow(),
  },
  (t) => [index('auth_code_sends_email_sent_at_idx').on(t.email, t.sentAt)],
);

export const users = pgTable(
  'users',
  {
    // Phase 29: the same id as the user's auth_users row; a profile cannot
    // exist without a sign-in identity (spec D9). The default predates the
    // foreign key and now only produces ids the key refuses: every insert
    // supplies the session's id (repo/users.ts).
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()::text`)
      .references(() => authUsers.id),
    username: text('username').notNull().unique(),
    displayName: text('display_name').notNull(),
    age: integer('age').notNull(),
    // No default: onboarding always supplies it, so a default could only mask a
    // bug. Profile information from phase 16 on — the pair a learner studies
    // lives on their enrollments, and nothing on the learning path reads this.
    nativeLanguage: varchar('native_language', { length: 10 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Mirrors UsernameSchema in packages/core exactly. Two enforcement points
    // for one rule is deliberate: the schema gives a 400 with a good message,
    // the constraint is what actually holds when something bypasses the route.
    check('users_username_format', sql`${t.username} ~ '^[a-z0-9_]{3,30}$'`),
    check('users_display_name_length', sql`length(${t.displayName}) between 1 and 60`),
    check('users_age_range', sql`${t.age} between 3 and 120`),
  ],
);

/**
 * Phase 16. A course of study: one target language, explained in one source
 * language. A learner holds several, at most one per target.
 *
 * No UNIQUE(user_id) — the app switches between enrollments — and no "active"
 * column anywhere: which one is active is a fact about one device's screen,
 * held client-side, so every request names its enrollment or its pair.
 *
 * `UNIQUE(user_id, id)` exists only to be the target of the composite foreign
 * keys below, the same pattern answers uses against session_questions: it
 * proves the referencing row's user owns the enrollment.
 *
 * The source CHECK allows `en` because English-native learners existed before
 * this phase and migrate unchanged; new enrollments are Hebrew-explained, a
 * restriction the API publishes (EnrollmentSourceSchema), not the schema.
 */
export const enrollments = pgTable(
  'enrollments',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    userId: text('user_id').notNull(),
    sourceLanguage: varchar('source_language', { length: 10 }).notNull(),
    targetLanguage: varchar('target_language', { length: 10 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'enrollments_user_fk', columns: [t.userId], foreignColumns: [users.id] }),
    unique('enrollments_user_target_key').on(t.userId, t.targetLanguage),
    unique('enrollments_user_id_id_key').on(t.userId, t.id),
    check('enrollments_languages_differ', sql`${t.sourceLanguage} <> ${t.targetLanguage}`),
    check('enrollments_source_known', sql`${t.sourceLanguage} in ('he', 'en')`),
    check('enrollments_target_known', sql`${t.targetLanguage} in ('he', 'en', 'ru', 'it')`),
  ],
);

/**
 * Phase 28 (spec D1–D5). An access grant: someone other than an enrollment's
 * owner may act on it, as far as the grant's role allows. domain/access.ts maps
 * roles to permissions; services/access.ts is the one check (ADR 0008). The
 * grant names its TARGET, which is what a role column on users could not do
 * (phase 8, "Why `users` has no role column").
 *
 * accepted_at null is an invite. Declining, cancelling and ending all delete the
 * row: nothing reads an ended grant, and words a tutor added keep their label
 * through vocabulary_entries.added_by_user_id, not through this row.
 *
 * owner_user_id is the enrollment's user, held here only so the composite FK
 * into enrollments_user_id_id_key can prove it and the CHECK can compare it.
 * Read and written only by repo/grants.ts (ADR 0008 R1).
 */
export const enrollmentGrants = pgTable(
  'enrollment_grants',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    enrollmentId: text('enrollment_id').notNull(),
    ownerUserId: text('owner_user_id').notNull(),
    granteeUserId: text('grantee_user_id').notNull(),
    role: text('role').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'enrollment_grants_enrollment_fk',
      columns: [t.ownerUserId, t.enrollmentId],
      foreignColumns: [enrollments.userId, enrollments.id],
    }),
    foreignKey({ name: 'enrollment_grants_grantee_fk', columns: [t.granteeUserId], foreignColumns: [users.id] }),
    unique('enrollment_grants_enrollment_grantee_key').on(t.enrollmentId, t.granteeUserId),
    check('enrollment_grants_not_owner', sql`${t.granteeUserId} <> ${t.ownerUserId}`),
    check('enrollment_grants_role_known', sql`${t.role} in ('tutor')`),
    index('enrollment_grants_grantee_idx').on(t.granteeUserId),
    index('enrollment_grants_owner_idx').on(t.ownerUserId),
  ],
);

export const dictLexemes = pgTable(
  'dict_lexemes',
  {
    // Server-issued from phase 10, as users.id has been since 0001: with the
    // dictionary now written at request time, a client-generated id would mean
    // randomness in a layer ADR 0002 R1 would have to police.
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    languageCode: varchar('language_code', { length: 10 }).notNull(),
    lemma: text('lemma').notNull(),
    // A lexeme: the pair of a lemma and a part of speech. It moved up from the
    // sense, where phase 10 put it. Part of speech does describe a meaning, but
    // it also decides which forms a headword has, and only the lexeme can carry
    // that — which is what stops `booked` reaching the noun's senses.
    partOfSpeech: varchar('part_of_speech', { length: 50 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Bumped whenever this lexeme gains a sense. A variant records the value it
    // was rendered against, and a variant that is behind is re-rendered on its
    // next lookup — which is what stops two forms of one word disagreeing about
    // how many meanings it has.
    senseVersion: integer('sense_version').notNull().default(0),
  },
  (t) => [
    unique('dict_lexemes_language_lemma_pos_key').on(t.languageCode, t.lemma, t.partOfSpeech),
    // Phase 21. What vocabulary_entries_lexeme_lemma_fk references: an entry's
    // copied lemma must be its lexeme's. Redundant as a uniqueness rule (id is the
    // primary key), required by Postgres as a foreign-key target.
    unique('dict_lexemes_id_lemma_key').on(t.id, t.lemma),
  ],
);

export const dictVariants = pgTable(
  'dict_variants',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    lexemeId: text('lexeme_id')
      .notNull()
      .references(() => dictLexemes.id, { onDelete: 'cascade' }),
    // Copied from the term so the unique index below can exist: the scope that
    // matters is one form in one language, but language lives on dict_lexemes
    // and an index reads one table. A term's language never changes, so the
    // copy cannot go stale — and it earns its keep in the read, which no
    // longer joins dict_lexemes at all.
    languageCode: varchar('language_code', { length: 10 }).notNull(),
    // Stored as it was written; matching is always lower(form). One rule for a
    // recorded `How do you do?` and for a learner who typed `BOOK`.
    form: text('form').notNull(),
    kind: text('kind').notNull(),
    // Which reading of this form this term is, as the model ranked them. It
    // sits on the variant rather than the term because it is a property of the
    // pairing: `saw` ranks `see` first, while `saws` returns `saw` alone at 0.
    entryRank: integer('entry_rank').notNull(),
  },
  (t) => [
    // Per term, so one form may belong to several terms — `saw` is a variant of
    // `see` *and* of `saw`, which is what every lexical source does.
    unique('dict_variants_lexeme_form_key').on(t.lexemeId, t.form),
    check('dict_variants_entry_rank_nonneg', sql`${t.entryRank} >= 0`),
    // Two jobs in one index. Its (language_code, lower(form)) prefix is exactly
    // the read's predicate, so there is no separate lookup index; its third
    // column enforces that no two terms claim the same reading of one form.
    // That cannot currently happen — a written form thereafter hits, and ranks
    // within one write are distinct by construction — which is the point: a
    // safety net for a write bug, exactly like UNIQUE(lexeme_id, rank).
    uniqueIndex('dict_variants_form_entry_rank_key').on(
      t.languageCode,
      sql`lower(${t.form})`,
      t.entryRank,
    ),
  ],
);

export const dictSenses = pgTable(
  'dict_senses',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    lexemeId: text('lexeme_id')
      .notNull()
      .references(() => dictLexemes.id, { onDelete: 'cascade' }),
    // Model-supplied. Phase 10 called this decoration; from phase 12 it is
    // load-bearing, and the unique key below is why: it is the only handle a
    // later form's translations have on senses this lexeme already holds.
    senseCode: text('sense_code').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // The table is pure identity now. `part_of_speech` went up to the lexeme, and
  // `rank` and `example_source` went down to the translation: a sense has no
  // order and no example of its own, only a position and a wording within some
  // given form's answer.
  (t) => [unique('dict_senses_lexeme_code_key').on(t.lexemeId, t.senseCode)],
);

export const dictVarTranslations = pgTable(
  'dict_var_translations',
  {
    // The variant joins the key in phase 12, which is what makes an answer
    // belong to the form that was typed: `booked` renders הזמין where `book`
    // renders להזמין, and both are the same sense of the same lexeme.
    variantId: text('variant_id')
      .notNull()
      .references(() => dictVariants.id, { onDelete: 'cascade' }),
    senseId: text('sense_id')
      .notNull()
      .references(() => dictSenses.id, { onDelete: 'cascade' }),
    userLanguageCode: varchar('user_language_code', { length: 10 }).notNull(),
    translation: text('translation').notNull(),
    definitionNotes: text('definition_notes'),
    // Both halves of the example live here, because an example belongs to the
    // form that was typed: `booked` shows "I booked a table", not "I want to
    // book a table". The source half is duplicated per target language, which is
    // cheaper than a fifth table to normalise it.
    exampleSource: text('example_source'),
    exampleTarget: text('example_target'),
    // "Most common first", scoped to THIS form. It sits here rather than on the
    // sense so that a sense a later form introduces lands where that form ranked
    // it, instead of at max(rank)+1 — arrival order wearing a rank's clothes —
    // and so that the lexeme's order does not depend on which form was looked up
    // first. Values are the sense's position in the entry the model returned.
    rank: integer('rank').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.variantId, t.senseId, t.userLanguageCode] }),
    unique('dict_var_translations_variant_rank_key').on(
      t.variantId,
      t.userLanguageCode,
      t.rank,
    ),
    check('dict_var_translations_rank_nonneg', sql`${t.rank} >= 0`),
    // Phase 18. The primary key leads with variant_id, so "which renderings does
    // this SENSE have in this language" — the vocabulary list's sense_count and
    // the drill-down's representative rendering — would otherwise scan the
    // dictionary's largest table. findSensesByLexeme's join on tr.sense_id
    // benefits too.
    index('dict_var_translations_sense_language_idx').on(t.senseId, t.userLanguageCode),
  ],
);

/**
 * Phase 16. The lexeme's sense_version a form's translations were last written
 * against, PER EXPLANATION LANGUAGE. It replaces dict_variants'
 * rendered_sense_version, which was one counter for every language: a repair
 * rendering `en` stamped the variant level and left its `ru` rows behind with
 * nothing to record it (the caveat that column's comment carried since phase 12).
 *
 * A row exists exactly when the variant has translations in that language:
 * persistEntries and repairVariantRenderings upsert it, and migration 0008
 * backfilled it. The stale read therefore INNER-joins it — a language with no
 * row is one the form is never served in, so there is nothing to repair.
 *
 * NOT a count of translations, for the reason the old column gave: a form may
 * legitimately render fewer senses than its lexeme holds.
 */
export const dictVariantRenderings = pgTable(
  'dict_variant_renderings',
  {
    variantId: text('variant_id').notNull(),
    userLanguageCode: varchar('user_language_code', { length: 10 }).notNull(),
    renderedSenseVersion: integer('rendered_sense_version').notNull(),
  },
  (t) => [
    primaryKey({ name: 'dict_variant_renderings_pkey', columns: [t.variantId, t.userLanguageCode] }),
    foreignKey({
      name: 'dict_variant_renderings_variant_fk',
      columns: [t.variantId],
      foreignColumns: [dictVariants.id],
    }).onDelete('cascade'),
  ],
);

/**
 * Phase 13. `typed_form → corrected_form` plus ranked alternatives: a misspelling
 * is a ROUTING fact, not a dictionary fact. `thruot` is not a form of `throat` —
 * it is a string that should be read as one, and storing it as a variant would
 * mean inventing a per-form rendering, an example sentence and a rank ordering
 * for a string that is not a word.
 *
 * **No id and no primary key, which is deliberate.** Nothing can reference a
 * redirect: no foreign key points at one, corrections.jsonl keys a line by
 * typed_form, and persistCorrection addresses a row by
 * (language_code, lower(typed_form)). An id would be a column that exists only to
 * look like the neighbours. The unique index below is the row's whole identity.
 * Adding `id text PRIMARY KEY` later is an additive migration that changes no
 * query here.
 *
 * **`corrected_form` is a plain string, not a foreign key.** Referencing
 * dict_variants.id would couple the redirect to a row `TRUNCATE ... CASCADE` can
 * remove; as a string, a dangling redirect degrades into a miss and a model call
 * rather than raising.
 *
 * **Global, with no user_id.** That `thruot` is not an English word is a fact
 * about English. Phase 12 keeps "nothing records who asked" and ADR 0005 leaves
 * identity unauthenticated.
 *
 * The three CHECKs mirror TranslationCorrectionSchema, on the precedent `users`
 * set: the schema gives a 400 with a good message, the constraint is what
 * actually holds when something bypasses the route — and `dict:restore` reaches
 * persistCorrection without passing through either schema. On the live path they
 * can never fire, which is what the ON CONFLICT DO NOTHING contract depends on.
 */
export const dictCorrections = pgTable(
  'dict_corrections',
  {
    languageCode: varchar('language_code', { length: 10 }).notNull(),
    // Stored as written; matched on lower(). One rule for a learner who typed
    // `Thruot` and one who typed `thruot`.
    typedForm: text('typed_form').notNull(),
    // A SURFACE form, never a lemma: `bokked` corrects to `booked`, not `book`.
    correctedForm: text('corrected_form').notNull(),
    alternatives: text('alternatives')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('dict_corrections_typed_form_length', sql`length(${t.typedForm}) between 1 and 100`),
    check(
      'dict_corrections_corrected_form_length',
      sql`length(${t.correctedForm}) between 1 and 100`,
    ),
    // An IMMUTABLE SQL function, the mechanism question_options_valid already
    // uses, installed where that one is — see db/migrate.ts.
    check('dict_corrections_alternatives_valid', sql`correction_alternatives_valid(${t.alternatives})`),
    // Matching on an expression index is exactly what
    // dict_variants_form_entry_rank_key does.
    uniqueIndex('dict_corrections_form_key').on(t.languageCode, sql`lower(${t.typedForm})`),
  ],
);

/**
 * Phase 18. A learner's word list, one row per (enrollment, sense): the research
 * verdict, held as a primary key. Saving a meaning again from another form is ON
 * CONFLICT DO NOTHING, so the first form wins.
 *
 * `variant_id` is the form the sense was first saved from. It is not part of the
 * key; it is here because a sense has no wording of its own — translations and
 * examples live on dict_var_translations, per form — and the saved form is the
 * one rendering certain to exist.
 *
 * `lexeme_id` is a copy of dict_senses.lexeme_id. A sense never changes lexeme,
 * so the copy cannot go stale (dict_variants.language_code's reasoning), and it
 * keeps dict_senses out of every vocabulary read.
 *
 * **No FK to dict_var_translations**, though (variant, sense, language) would be
 * the tightest constraint: repairVariantRenderings deletes and re-inserts a
 * variant's renderings, which a statement-level FK would reject. The service
 * checks the rendering at save time; the repair's "may not drop a sense" rule
 * keeps it true afterwards.
 *
 * **No index on sense_id, variant_id or lexeme_id alone.** Postgres does not
 * index the referencing side of an FK, so a cascade from ONE deleted dictionary
 * row would scan this table. Nothing deletes dictionary rows one at a time:
 * db:reseed's TRUNCATE ... CASCADE does no lookups, and the dictionary has no
 * TTL. A phase that adds a per-row delete adds the index it needs.
 *
 * No user_id: sessions and questions carry one for their composite FK; an entry
 * reaches its learner through its enrollment, and nothing queries by user.
 */
export const vocabularyEntries = pgTable(
  'vocabulary_entries',
  {
    enrollmentId: text('enrollment_id').notNull(),
    senseId: text('sense_id').notNull(),
    lexemeId: text('lexeme_id').notNull(),
    // Phase 21. The lexeme's lemma, copied at save time. The saved list groups by
    // it, and the copy is what keeps that list as cheap as phase 20's: joining
    // dict_lexemes at read time measured 98.6 ms against a 50 ms budget (spec §1).
    // vocabulary_entries_lexeme_lemma_fk keeps it equal to the lexeme's.
    lemma: text('lemma').notNull(),
    variantId: text('variant_id').notNull(),
    // Phase 28 (spec D5). Who put this sense in the list: the owner, or a
    // grantee such as a tutor. NOT NULL so no reader has to know that null
    // means "the owner"; the migration backfilled older rows to the owner.
    addedByUserId: text('added_by_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'vocabulary_entries_pkey', columns: [t.enrollmentId, t.senseId] }),
    foreignKey({
      name: 'vocabulary_entries_enrollment_fk',
      columns: [t.enrollmentId],
      foreignColumns: [enrollments.id],
    }),
    foreignKey({
      name: 'vocabulary_entries_sense_fk',
      columns: [t.senseId],
      foreignColumns: [dictSenses.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'vocabulary_entries_lexeme_lemma_fk',
      columns: [t.lexemeId, t.lemma],
      foreignColumns: [dictLexemes.id, dictLexemes.lemma],
    })
      .onDelete('cascade')
      .onUpdate('cascade'),
    foreignKey({
      name: 'vocabulary_entries_variant_fk',
      columns: [t.variantId],
      foreignColumns: [dictVariants.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'vocabulary_entries_added_by_fk',
      columns: [t.addedByUserId],
      foreignColumns: [users.id],
    }),
    // Every read is scoped to one enrollment, which is what keeps the table's
    // total size irrelevant. Phase 21 reads by lemma: the list's GROUP BY lemma /
    // max(created_at), the summaries' counts, and the detail's saved entries.
    index('vocabulary_entries_enrollment_lemma_idx').on(t.enrollmentId, t.lemma, t.createdAt),
  ],
);

/**
 * Phase 20. How well a learner knows one saved sense, per knowledge dimension
 * (spec §2). Five rows per vocabulary entry, written with it in the save
 * transaction (repo/vocabulary.ts insertEntries), so "not practised" is a level
 * 1 row and never a missing one, and a dimension that goes live later needs no
 * backfill.
 *
 * The level only rises. The two dates are the whole state the step rule needs
 * (domain/progress.ts): the UTC day of the last step and of the last mistake.
 * mode 'string' because node-postgres would otherwise turn a date into a JS Date
 * at local midnight.
 *
 * The FK into vocabulary_entries cascades: unsaving a sense drops its progress,
 * and a re-save starts at level 1. Only answers given while a sense is saved
 * count.
 *
 * The dimension CHECK lists the same five names as DIMENSIONS in
 * packages/core. A literal, because drizzle-kit reads this file on its own; the
 * schema tests insert every DIMENSIONS value, which keeps the two equal.
 *
 * sense_progress_enrollment_dimension_idx serves the list's level and
 * filter as an index-only scan of one enrollment's live-dimension rows.
 * Measured while planning at the plan test's volume: 35 ms without it, 12 ms
 * with it, for a 20k-word enrollment's first page. `level` is a key column
 * rather than INCLUDE because drizzle-kit cannot express INCLUDE.
 */
export const senseProgress = pgTable(
  'sense_progress',
  {
    enrollmentId: text('enrollment_id').notNull(),
    senseId: text('sense_id').notNull(),
    dimension: text('dimension').notNull(),
    level: integer('level').notNull().default(1),
    lastStepOn: date('last_step_on', { mode: 'string' }),
    lastWrongOn: date('last_wrong_on', { mode: 'string' }),
  },
  (t) => [
    primaryKey({ name: 'sense_progress_pkey', columns: [t.enrollmentId, t.senseId, t.dimension] }),
    foreignKey({
      name: 'sense_progress_entry_fk',
      columns: [t.enrollmentId, t.senseId],
      foreignColumns: [vocabularyEntries.enrollmentId, vocabularyEntries.senseId],
    }).onDelete('cascade'),
    check(
      'sense_progress_dimension_known',
      sql`${t.dimension} in ('written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling')`,
    ),
    check('sense_progress_level_range', sql`${t.level} between 1 and 5`),
    index('sense_progress_enrollment_dimension_idx').on(t.enrollmentId, t.dimension, t.senseId, t.level),
  ],
);

export const questions = pgTable(
  'questions',
  {
    id: text('id').primaryKey(),
    // Nullable: NULL means shared. A per-learner row carries both halves of its
    // owner — user and enrollment — or neither; nothing writes one yet.
    userId: text('user_id').references(() => users.id),
    enrollmentId: text('enrollment_id'),
    senseId: text('sense_id')
      .notNull()
      .references(() => dictSenses.id),
    promptVariantId: text('prompt_variant_id')
      .notNull()
      .references(() => dictVariants.id),
    targetLanguage: varchar('target_language', { length: 10 }).notNull(),
    userLanguageCode: varchar('user_language_code', { length: 10 }).notNull(),
    type: varchar('type', { length: 50 }).notNull(),
    // Phase 23. A choice's options; null on a typed card, which has none.
    options: jsonb('options').$type<QuestionOption[]>(),
    // Phase 23. The Hebrew prompt of a reversed or typed card, stored rather
    // than joined: a later repair may rewrite the rendering, and a question
    // records what was asked. Today's card prompts with the variant's form.
    prompt: text('prompt'),
    // Phase 23. A typed card's other right answers, at most five.
    alternatives: text('alternatives').array(),
    // Phase 24. A tiles card's tiles: its letters and two more, shuffled.
    tiles: text('tiles').array(),
    // Phase 27. A sentence card's text in the target language (a cloze card's
    // blanked sentence, a translation card's reference), its Hebrew, and the
    // gap's offsets into `sentence`. All four are set for the three sentence
    // types and null for every other (questions_sentence_valid).
    sentence: text('sentence'),
    sentenceTranslation: text('sentence_translation'),
    gapStart: integer('gap_start'),
    gapEnd: integer('gap_end'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('questions_options_valid', sql`${t.options} is null or question_options_valid(${t.options})`),
    check(
      'questions_type_known',
      sql`${t.type} in ('multiple_choice', 'reverse_choice', 'typed_translation', 'listen_choice', 'dictation', 'matching', 'letter_tiles', 'read_aloud', 'say_translation', 'typed_meaning', 'cloze_choice', 'cloze_typed', 'sentence_translation')`,
    ),
    // Phase 23 and 24. Each type's shape (spec D13, phase 24 §2): a choice has
    // options, every type but the Hebrew-option ones stores the Hebrew prompt,
    // only a typed card has alternatives, and only a tiles card has tiles.
    // Phase 25's two speaking types store the Hebrew as their prompt, and say
    // the translation its alternatives, as the typed card does.
    // Phase 27's meaning recall stores the meaning as its prompt and nothing else;
    // its sentence cards store the Hebrew meaning as the prompt, a cloze choice with
    // options, a typed cloze with alternatives, a translation with neither.
    check(
      'questions_shape_valid',
      sql`case ${t.type}
        when 'multiple_choice' then ${t.options} is not null and ${t.prompt} is null and ${t.alternatives} is null and ${t.tiles} is null
        when 'listen_choice' then ${t.options} is not null and ${t.prompt} is null and ${t.alternatives} is null and ${t.tiles} is null
        when 'matching' then ${t.options} is not null and ${t.prompt} is null and ${t.alternatives} is null and ${t.tiles} is null
        when 'reverse_choice' then ${t.options} is not null and ${t.prompt} is not null and ${t.alternatives} is null and ${t.tiles} is null
        when 'typed_translation' then ${t.options} is null and ${t.prompt} is not null and ${t.tiles} is null
          and ${t.alternatives} is not null and coalesce(array_length(${t.alternatives}, 1), 0) <= 5
        when 'dictation' then ${t.options} is null and ${t.prompt} is not null and ${t.alternatives} is null and ${t.tiles} is null
        when 'letter_tiles' then ${t.options} is null and ${t.prompt} is not null and ${t.alternatives} is null
          and coalesce(array_length(${t.tiles}, 1), 0) between 5 and 12
        when 'read_aloud' then ${t.options} is null and ${t.prompt} is not null and ${t.alternatives} is null and ${t.tiles} is null
        when 'say_translation' then ${t.options} is null and ${t.prompt} is not null and ${t.tiles} is null
          and ${t.alternatives} is not null and coalesce(array_length(${t.alternatives}, 1), 0) <= 5
        when 'typed_meaning' then ${t.options} is null and ${t.prompt} is not null and ${t.alternatives} is null and ${t.tiles} is null
        when 'cloze_choice' then ${t.options} is not null and ${t.prompt} is not null and ${t.alternatives} is null and ${t.tiles} is null
        when 'cloze_typed' then ${t.options} is null and ${t.prompt} is not null and ${t.tiles} is null
          and ${t.alternatives} is not null and coalesce(array_length(${t.alternatives}, 1), 0) <= 5
        when 'sentence_translation' then ${t.options} is null and ${t.prompt} is not null and ${t.alternatives} is null and ${t.tiles} is null
        else false end`,
    ),
    // Phase 27 (spec D11). The sentence columns belong to the three sentence
    // types, all four together, and the gap lies inside the sentence.
    check(
      'questions_sentence_valid',
      sql`(${t.type} in ('cloze_choice', 'cloze_typed', 'sentence_translation')) = (${t.sentence} is not null)
        and (${t.type} in ('cloze_choice', 'cloze_typed', 'sentence_translation')) = (${t.sentenceTranslation} is not null)
        and (${t.type} in ('cloze_choice', 'cloze_typed', 'sentence_translation')) = (${t.gapStart} is not null)
        and (${t.type} in ('cloze_choice', 'cloze_typed', 'sentence_translation')) = (${t.gapEnd} is not null)
        and (${t.gapStart} is null or (${t.gapStart} >= 0 and ${t.gapStart} < ${t.gapEnd} and ${t.gapEnd} <= length(${t.sentence})))`,
    ),
    foreignKey({
      name: 'questions_enrollment_fk',
      columns: [t.userId, t.enrollmentId],
      foreignColumns: [enrollments.userId, enrollments.id],
    }),
    check('questions_owner_complete', sql`(${t.userId} is null) = (${t.enrollmentId} is null)`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    // Phase 16. The course this session belongs to. With user_id it references
    // enrollments (user_id, id), so a session can only be recorded against an
    // enrollment its own learner holds.
    enrollmentId: text('enrollment_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Set together with status = 'completed', and only then
    // (sessions_completed_consistent).
    completedAt: timestamp('completed_at', { withTimezone: true }),
    // Phase 19. preparing → ready → completed, or skipped / failed. "In progress"
    // is not a status: it is `ready` with at least one answer. No default:
    // every insert says which one it is, so a default could only hide a bug.
    status: text('status').notNull(),
    // Phase 19. Where the questions came from: the shared seed, or the
    // enrollment's saved senses.
    source: text('source').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'sessions_enrollment_fk',
      columns: [t.userId, t.enrollmentId],
      foreignColumns: [enrollments.userId, enrollments.id],
    }),
    check(
      'sessions_status_known',
      sql`${t.status} in ('preparing', 'ready', 'completed', 'skipped', 'failed')`,
    ),
    check('sessions_source_known', sql`${t.source} in ('seed', 'list')`),
    check(
      'sessions_completed_consistent',
      sql`(${t.status} = 'completed') = (${t.completedAt} is not null)`,
    ),
    // The one-open-session rule as a constraint. A concurrent second create
    // fails here and becomes a 409, which no read-then-insert check could
    // promise.
    uniqueIndex('sessions_one_open_per_enrollment')
      .on(t.enrollmentId)
      .where(sql`${t.status} in ('preparing', 'ready')`),
    // The home screen's read: one enrollment's newest session. Nothing indexed
    // sessions by enrollment before, and this read runs on every focus and every
    // 3 s poll.
    index('sessions_enrollment_created_idx').on(t.enrollmentId, t.createdAt),
  ],
);

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
    // Null for a typed answer (phase 23), which records its text and verdict.
    selectedOptionPosition: integer('selected_option_position'),
    typedText: text('typed_text'),
    // How the typed text was judged when it was answered: the history records
    // what the learner was told (spec D12).
    verdict: text('verdict'),
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
    // Phase 23. Exactly one kind of answer, and a verdict exactly with text.
    check(
      'answers_kind_valid',
      sql`(${t.selectedOptionPosition} is null) = (${t.typedText} is not null) and (${t.typedText} is null) = (${t.verdict} is null)`,
    ),
    check(
      'answers_verdict_known',
      sql`${t.verdict} in ('exact', 'near_miss', 'alternative', 'wrong', 'understood', 'gave_up', 'skipped')`,
    ),
    // Phase 27 (spec D11): a judged answer is at most 300 characters.
    check('answers_typed_text_length', sql`length(${t.typedText}) <= 300`),
  ],
);

/**
 * Phase 20. What one ended session did to each progress row of each saved
 * sense it practised: all five dimensions, moved or not. It is what lets the
 * results be read again after the session ended, and what the recompute
 * rebuilds. No FK to sense_progress: on the live path a sense unsaved later
 * keeps its history here, and the results of an old session still read. A
 * recompute rebuilds only what the current saves can explain, so it drops the
 * rows of a sense unsaved since.
 */
export const sessionProgress = pgTable(
  'session_progress',
  {
    sessionId: uuid('session_id').notNull(),
    senseId: text('sense_id').notNull(),
    dimension: text('dimension').notNull(),
    levelBefore: integer('level_before').notNull(),
    levelAfter: integer('level_after').notNull(),
  },
  (t) => [
    primaryKey({ name: 'session_progress_pkey', columns: [t.sessionId, t.senseId, t.dimension] }),
    foreignKey({
      name: 'session_progress_session_fk',
      columns: [t.sessionId],
      foreignColumns: [sessions.id],
    }).onDelete('cascade'),
    check(
      'session_progress_dimension_known',
      sql`${t.dimension} in ('written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling')`,
    ),
    check(
      'session_progress_levels_valid',
      sql`${t.levelBefore} between 1 and 5 and ${t.levelAfter} between ${t.levelBefore} and 5`,
    ),
  ],
);

/**
 * Phase 26. One photo of a word list (spec D4). `photo` is the base64 JPEG,
 * kept only until the read (spec D3): every transition clears it, and the
 * check below makes that a property of the table. `ready` is not a status: it
 * is `read` with no row pending.
 */
export const photoImports = pgTable(
  'photo_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    enrollmentId: text('enrollment_id').notNull(),
    status: text('status').notNull(),
    photo: text('photo'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'photo_imports_enrollment_fk',
      columns: [t.enrollmentId],
      foreignColumns: [enrollments.id],
    }),
    check('photo_imports_status_known', sql`${t.status} in ('reading', 'read', 'failed', 'saved', 'discarded')`),
    check('photo_imports_photo_only_while_reading', sql`${t.photo} is null or ${t.status} = 'reading'`),
    // The list and the cleanup both read one enrollment's imports by age.
    index('photo_imports_enrollment_created_idx').on(t.enrollmentId, t.createdAt),
  ],
);

/**
 * Phase 26. One word or phrase read from an import's photo, with its lookup's
 * saveable senses as a snapshot (`options`), the sense the job chose
 * (`suggested_sense_id`, never changed after) and the learner's choice.
 */
export const photoImportItems = pgTable(
  'photo_import_items',
  {
    importId: uuid('import_id').notNull(),
    position: integer('position').notNull(),
    text: text('text').notNull(),
    hebrew: text('hebrew'),
    status: text('status').notNull(),
    correctedForm: text('corrected_form'),
    options: jsonb('options').$type<PhotoImportOption[]>().notNull().default(sql`'[]'::jsonb`),
    suggestedSenseId: text('suggested_sense_id'),
    chosenSenseId: text('chosen_sense_id'),
    ticked: boolean('ticked').notNull().default(false),
    hebrewMismatch: boolean('hebrew_mismatch').notNull().default(false),
    reason: text('reason'),
  },
  (t) => [
    primaryKey({ name: 'photo_import_items_pkey', columns: [t.importId, t.position] }),
    foreignKey({
      name: 'photo_import_items_import_fk',
      columns: [t.importId],
      foreignColumns: [photoImports.id],
    }).onDelete('cascade'),
    check('photo_import_items_status_known', sql`${t.status} in ('pending', 'ready', 'failed')`),
    check(
      'photo_import_items_reason_known',
      sql`${t.reason} is null or ${t.reason} in ('sentence', 'no_meaning', 'not_in_language')`,
    ),
    check('photo_import_items_tick_needs_sense', sql`not ${t.ticked} or ${t.chosenSenseId} is not null`),
  ],
);
