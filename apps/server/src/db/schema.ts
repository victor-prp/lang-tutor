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
  real,
  smallint,
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
    // Phase 35 (spec D11). A bot is a profile that plays on a clock of its own:
    // `bot_day` is its day, set for bots only. Read and written in repo/users.ts
    // alone (ADR 0013 R2).
    kind: text('kind').notNull().default('learner'),
    botDay: date('bot_day', { mode: 'string' }),
    // Phase 52 (spec D1). The learner's IANA time zone, reported by the app on
    // every launch (PUT /api/me/time-zone). The default is UTC, which is what
    // the day was before and what a learner who never reports one keeps.
    timeZone: text('time_zone').notNull().default('UTC'),
  },
  (t) => [
    check('users_kind_known', sql`${t.kind} in ('learner', 'bot')`),
    check('users_bot_day_iff_bot', sql`(${t.kind} = 'bot') = (${t.botDay} is not null)`),
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
    // Phase 31 (spec D9). One short phrase in the headword's language: the handle
    // a learner language with no renderings yet reconciles against. Written by
    // the call that names the sense; null for a sense written before the phase
    // until a lookup touches it. Never shown to a learner.
    definition: text('definition'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // The table is pure identity now. `part_of_speech` went up to the lexeme, and
  // `rank` and `example_source` went down to the translation: a sense has no
  // order and no example of its own, only a position and a wording within some
  // given form's answer.
  (t) => [
    unique('dict_senses_lexeme_code_key').on(t.lexemeId, t.senseCode),
    // Phase 31. The target of dict_sense_glosses' composite foreign key, which is
    // what makes Postgres hold "a sense and its gloss share a lexeme".
    unique('dict_senses_id_lexeme_key').on(t.id, t.lexemeId),
  ],
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
    // Phase 31 (spec D6). The citation form the model gave this rendering's
    // sense, uninflected: `fingers` renders אצבעות and records אצבע here. A
    // session asks this form only while it agrees with its gloss's key (D12).
    gloss: text('gloss').notNull(),
    // Phase 31 (spec D5). The sense's other target words in this form's
    // inflection: the lookup card's "also …", and right answers to a meaning
    // card built on this form (D13). Never more than five (tidyGlossList).
    alternatives: text('alternatives').array().notNull().default(sql`'{}'::text[]`),
    // Phase 34 (spec D1). Every target-language word that translates this
    // rendering in its sense, inflected to agree with it: the list every typed or
    // spoken card built on the rendering accepts. Written only by the accept job,
    // never more than ten, and empty both before the job has run and when it found
    // nothing, which `accepted_at` tells apart.
    acceptedAnswers: text('accepted_answers').array().notNull().default(sql`'{}'::text[]`),
    // Phase 34 (spec D2). The form of the headword that agrees with the rendering
    // in number and person (`ore` for שעות); null when it is the variant's own form.
    answerForm: text('answer_form'),
    // Phase 34 (spec D1). When the accept job last ran for this rendering; null =
    // never. What "done" means, so a rendering the job found nothing for is not
    // paid for again.
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
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
    // Phase 34 (spec D1). The cap is ten here and on questions.alternatives.
    check('dict_var_translations_accepted_answers_cap', sql`cardinality(${t.acceptedAnswers}) <= 10`),
    // Phase 18. The primary key leads with variant_id, so "which renderings does
    // this SENSE have in this language" — the drill-down's renderings (and,
    // until phase 31 counted glosses, the vocabulary list's sense count) —
    // would otherwise scan the dictionary's largest table. findSensesByLexeme's
    // join on tr.sense_id benefits too.
    index('dict_var_translations_sense_language_idx').on(t.senseId, t.userLanguageCode),
  ],
);

/**
 * Phase 31 (spec D1, D2, D7). A gloss: one target word of one lexeme in one
 * learner language, and what a learner saves, levels and practises. Its senses
 * are in dict_sense_glosses; a sense has one gloss per language, so `mouse`'s two
 * senses are one gloss for Hebrew and would be two for Italian.
 *
 * `key` is the target word's citation form as the model wrote it. Two live
 * glosses of one lexeme and language never share a normalised key
 * (dict_glosses_live_key, on gloss_key(), the SQL twin of normaliseGloss).
 * `alternatives` are the sense's other target words, in citation form.
 *
 * `merged_into` is set when a merge folded this gloss into another (D7). The row
 * stays, so an id still on a learner's screen or in a photo import's snapshot
 * resolves to its survivor, and every read of live glosses skips it.
 */
export const dictGlosses = pgTable(
  'dict_glosses',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    lexemeId: text('lexeme_id').notNull(),
    userLanguageCode: varchar('user_language_code', { length: 10 }).notNull(),
    key: text('key').notNull(),
    alternatives: text('alternatives').array().notNull().default(sql`'{}'::text[]`),
    mergedInto: text('merged_into'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'dict_glosses_lexeme_fk', columns: [t.lexemeId], foreignColumns: [dictLexemes.id] }).onDelete('cascade'),
    foreignKey({ name: 'dict_glosses_merged_into_fk', columns: [t.mergedInto], foreignColumns: [t.id] }),
    // The target of the composite keys that tie a membership and an entry to
    // their gloss's lexeme: phase 21's dict_lexemes_id_lemma_key trick.
    unique('dict_glosses_id_lexeme_key').on(t.id, t.lexemeId),
    uniqueIndex('dict_glosses_live_key')
      .on(t.lexemeId, t.userLanguageCode, sql`gloss_key(${t.key})`)
      .where(sql`${t.mergedInto} is null`),
    // Spec D18: a session's siblings are the live glosses of other lexemes with
    // one key in one language. Without it that read scans the table.
    index('dict_glosses_language_key_idx')
      .on(t.userLanguageCode, sql`gloss_key(${t.key})`)
      .where(sql`${t.mergedInto} is null`),
    check('dict_glosses_not_self', sql`${t.mergedInto} is null or ${t.mergedInto} <> ${t.id}`),
  ],
);

/**
 * Phase 31 (spec D1, D6, D8). Which gloss a sense belongs to in one learner
 * language. Written by the lookup and the repair in the transaction of the
 * rendering it comes with, and before that rendering (D8). The first rendering in
 * a language decides, and only a merge moves a membership (D6, D7).
 *
 * `lexeme_id` is here so both composite keys can hold "a sense and its gloss
 * share a lexeme": a noun's sense never joins a verb's gloss.
 */
export const dictSenseGlosses = pgTable(
  'dict_sense_glosses',
  {
    senseId: text('sense_id').notNull(),
    lexemeId: text('lexeme_id').notNull(),
    userLanguageCode: varchar('user_language_code', { length: 10 }).notNull(),
    glossId: text('gloss_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'dict_sense_glosses_pkey', columns: [t.senseId, t.userLanguageCode] }),
    foreignKey({
      name: 'dict_sense_glosses_sense_fk',
      columns: [t.senseId, t.lexemeId],
      foreignColumns: [dictSenses.id, dictSenses.lexemeId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'dict_sense_glosses_gloss_fk',
      columns: [t.glossId, t.lexemeId],
      foreignColumns: [dictGlosses.id, dictGlosses.lexemeId],
    }).onDelete('cascade'),
    // A gloss's members, for a session's renderings (D12) and a merge.
    index('dict_sense_glosses_gloss_idx').on(t.glossId),
    // A lexeme's memberships in one language, for the write's gloss step.
    index('dict_sense_glosses_lexeme_idx').on(t.lexemeId, t.userLanguageCode),
  ],
);

/**
 * Phase 31 (decided while planning, item 3; spec D12). One row per lexeme and
 * learner language whose lemma form's rendering has been requested, by a save,
 * the start-up backfill or `dict:lemmas:render`: the claim that keeps a second
 * request from being made. A render the job skipped (the lemma's lookup had no
 * entry for this headword) keeps its claim, since it would otherwise cost model
 * calls on every save and every container start. A render whose retries are
 * spent gives its claim back through the dead letter, so a later save or start
 * asks again.
 */
export const dictLemmaRenders = pgTable(
  'dict_lemma_renders',
  {
    lexemeId: text('lexeme_id').notNull(),
    userLanguageCode: varchar('user_language_code', { length: 10 }).notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'dict_lemma_renders_pkey', columns: [t.lexemeId, t.userLanguageCode] }),
    foreignKey({ name: 'dict_lemma_renders_lexeme_fk', columns: [t.lexemeId], foreignColumns: [dictLexemes.id] }).onDelete('cascade'),
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
 * Phase 18, re-keyed in phase 31 (spec D2). A learner's word list, one row per
 * (enrollment, gloss): the research verdict, held as a primary key. Saving a
 * meaning again from another form is ON CONFLICT DO NOTHING, so the first form
 * wins.
 *
 * `variant_id` is the form the gloss was first saved from. It is not part of the
 * key; it is here because a gloss has no wording per form — translations and
 * examples live on dict_var_translations, per form — and the saved form is the
 * one rendering certain to exist.
 *
 * `lexeme_id` is a copy of dict_glosses.lexeme_id. A gloss never changes lexeme,
 * so the copy cannot go stale (dict_variants.language_code's reasoning), and
 * vocabulary_entries_gloss_fk holds it equal to the gloss's.
 *
 * **No FK to dict_var_translations**, though (variant, sense, language) would be
 * the tightest constraint: repairVariantRenderings deletes and re-inserts a
 * variant's renderings, which a statement-level FK would reject. The service
 * checks the rendering at save time; the repair's "may not drop a sense" rule
 * keeps it true afterwards.
 *
 * **No index on gloss_id, variant_id or lexeme_id alone.** Postgres does not
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
    // Phase 31 (spec D2). The gloss saved: one target word of one headword in the
    // enrollment's learner language. Was sense_id (phase 18).
    glossId: text('gloss_id').notNull(),
    lexemeId: text('lexeme_id').notNull(),
    // Phase 21. The lexeme's lemma, copied at save time. The saved list groups by
    // it, and the copy is what keeps that list as cheap as phase 20's: joining
    // dict_lexemes at read time measured 98.6 ms against a 50 ms budget (spec §1).
    // vocabulary_entries_lexeme_lemma_fk keeps it equal to the lexeme's.
    lemma: text('lemma').notNull(),
    variantId: text('variant_id').notNull(),
    // Phase 28 (spec D5). Who put this gloss in the list: the owner, or a
    // grantee such as a tutor. NOT NULL so no reader has to know that null
    // means "the owner"; the migration backfilled older rows to the owner.
    addedByUserId: text('added_by_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Phase 46 (spec D3). When a session's refresh first saw this gloss known: every
    // live skill had reached KNOWN_STABILITY. Known for good from then on, in a family
    // or not; null if never.
    knownAt: timestamp('known_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ name: 'vocabulary_entries_pkey', columns: [t.enrollmentId, t.glossId] }),
    foreignKey({
      name: 'vocabulary_entries_enrollment_fk',
      columns: [t.enrollmentId],
      foreignColumns: [enrollments.id],
    }),
    // Phase 31. The gloss AND the lexeme, through dict_glosses_id_lexeme_key: an
    // entry's copied lexeme is its gloss's, which the sense key never held.
    foreignKey({
      name: 'vocabulary_entries_gloss_fk',
      columns: [t.glossId, t.lexemeId],
      foreignColumns: [dictGlosses.id, dictGlosses.lexemeId],
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
 * Phase 20, re-keyed in phase 31 (spec D16). How well a learner knows one saved
 * gloss, per knowledge dimension (spec §2). Five rows per vocabulary entry,
 * written with it in the save transaction (repo/vocabulary.ts insertEntries), so
 * "not practised" is a level 1 row and never a missing one, and a dimension that
 * goes live later needs no backfill.
 *
 * The level only rises. The two dates are the whole state the step rule needs
 * (domain/progress.ts): the UTC day of the last step and of the last mistake.
 * mode 'string' because node-postgres would otherwise turn a date into a JS Date
 * at local midnight.
 *
 * The FK into vocabulary_entries cascades: unsaving a gloss drops its progress,
 * and a re-save starts at level 1. Only answers given while a gloss is saved
 * count.
 *
 * The dimension CHECK lists the same five names as DIMENSIONS in
 * packages/core. A literal, because drizzle-kit reads this file on its own; the
 * schema tests insert every DIMENSIONS value, which keeps the two equal.
 *
 * gloss_progress_enrollment_dimension_idx serves the list's level and
 * filter as an index-only scan of one enrollment's live-dimension rows.
 * Measured while planning at the plan test's volume: 35 ms without it, 12 ms
 * with it, for a 20k-word enrollment's first page. `level` is a key column
 * rather than INCLUDE because drizzle-kit cannot express INCLUDE.
 */
export const glossProgress = pgTable(
  'gloss_progress',
  {
    enrollmentId: text('enrollment_id').notNull(),
    glossId: text('gloss_id').notNull(),
    dimension: text('dimension').notNull(),
    level: integer('level').notNull().default(1),
    lastStepOn: date('last_step_on', { mode: 'string' }),
    lastWrongOn: date('last_wrong_on', { mode: 'string' }),
  },
  (t) => [
    primaryKey({ name: 'gloss_progress_pkey', columns: [t.enrollmentId, t.glossId, t.dimension] }),
    // ON UPDATE CASCADE (phase 31): a merge moves an entry to its survivor
    // gloss, and its five rows follow it.
    foreignKey({
      name: 'gloss_progress_entry_fk',
      columns: [t.enrollmentId, t.glossId],
      foreignColumns: [vocabularyEntries.enrollmentId, vocabularyEntries.glossId],
    })
      .onDelete('cascade')
      .onUpdate('cascade'),
    check(
      'gloss_progress_dimension_known',
      sql`${t.dimension} in ('written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling')`,
    ),
    check('gloss_progress_level_range', sql`${t.level} between 1 and 5`),
    index('gloss_progress_enrollment_dimension_idx').on(t.enrollmentId, t.dimension, t.glossId, t.level),
  ],
);

/**
 * Phase 35 (spec D2). What the memory model holds per gloss and dimension:
 * FSRS stability and difficulty, the day of the last review, and the parameter
 * set that produced them. A dimension with no row is unintroduced.
 */
export const glossMemory = pgTable(
  'gloss_memory',
  {
    enrollmentId: text('enrollment_id').notNull(),
    glossId: text('gloss_id').notNull(),
    dimension: text('dimension').notNull(),
    stability: real('stability').notNull(),
    difficulty: real('difficulty').notNull(),
    lastDay: date('last_day', { mode: 'string' }).notNull(),
    reps: integer('reps').notNull(),
    lapses: integer('lapses').notNull(),
    params: text('params').notNull(),
    // Phase 46 (spec D1). The learner day this skill's stability first reached
    // KNOWN_STABILITY; kept after a lapse. Set by applySession, so the recompute
    // rebuilds it.
    reachedOn: date('reached_on', { mode: 'string' }),
  },
  (t) => [
    primaryKey({ name: 'gloss_memory_pkey', columns: [t.enrollmentId, t.glossId, t.dimension] }),
    foreignKey({
      name: 'gloss_memory_entry_fk',
      columns: [t.enrollmentId, t.glossId],
      foreignColumns: [vocabularyEntries.enrollmentId, vocabularyEntries.glossId],
    })
      .onDelete('cascade')
      .onUpdate('cascade'),
    check(
      'gloss_memory_dimension_known',
      sql`${t.dimension} in ('written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling')`,
    ),
    check('gloss_memory_stability_positive', sql`${t.stability} > 0`),
    check('gloss_memory_difficulty_range', sql`${t.difficulty} between 1 and 10`),
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
    // Phase 31. The gloss the card practises; prompt_variant_id names the one
    // form's rendering of one member it was built from (spec D12).
    glossId: text('gloss_id').notNull(),
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
    // Phase 23. A typed card's other right answers, at most five; ten from phase 34.
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
    // Phase 34 (spec D6, D7). A sentence that pins the sense of a card showing a
    // bare word, and its translation, which is never shown and goes to the judge.
    // Hebrew on a typed translation, say-the-translation or reverse choice; in the
    // target language on a typed meaning or multiple choice. Null on every other type.
    context: text('context'),
    contextTranslation: text('context_translation'),
    // The word the card marks in `context`, as offsets into it. Both null when the
    // service could not find the word, and the sentence is then shown unmarked.
    contextMarkStart: integer('context_mark_start'),
    contextMarkEnd: integer('context_mark_end'),
    // Phase 34 (spec D8). The practised word in `sentence_translation`, the Hebrew
    // of a typed cloze or a sentence translation. Both null = shown unmarked.
    sentenceMarkStart: integer('sentence_mark_start'),
    sentenceMarkEnd: integer('sentence_mark_end'),
    // Phase 34 (spec D2). The form of the headword the card asks for when the
    // rendering it was built from has one of its own (`ore`); null = the variant's.
    answerForm: text('answer_form'),
    // Phase 39 (spec D6). The meanings a new_meaning card listed as known, in family
    // order; set on that type and null on every other (questions_known_meanings_valid).
    knownMeanings: text('known_meanings').array(),
    // Phase 55 (spec D2, as ruled). A card of a ladder's intro stage: the meet card, the
    // read aloud and the card that writes the word. It counts in the score, and its answer
    // writes no memory and no progress and opens no return. False on every other card.
    intro: boolean('intro').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('questions_options_valid', sql`${t.options} is null or question_options_valid(${t.options})`),
    check(
      'questions_type_known',
      sql`${t.type} in ('multiple_choice', 'reverse_choice', 'typed_translation', 'listen_choice', 'dictation', 'matching', 'letter_tiles', 'read_aloud', 'say_translation', 'typed_meaning', 'cloze_choice', 'cloze_typed', 'sentence_translation', 'new_meaning', 'meet')`,
    ),
    // Phase 23 and 24. Each type's shape (spec D13, phase 24 §2): a choice has
    // options, every type but the Hebrew-option ones stores the Hebrew prompt,
    // only a typed card has alternatives, and only a tiles card has tiles.
    // Phase 25's two speaking types store the Hebrew as their prompt, and say
    // the translation its alternatives, as the typed card does.
    // Phase 27's meaning recall stores the meaning as its prompt and nothing else;
    // its sentence cards store the Hebrew meaning as the prompt, a cloze choice with
    // options, a typed cloze with alternatives, a translation with neither.
    // Phase 34 (spec D1, D6, D8): at most ten alternatives, a context only on the five
    // types that show a bare word, and a marked word in the Hebrew only on the two
    // sentence types that ask it.
    // Phase 54 (spec D7). A meet card stores the Hebrew meaning it shows as its
    // prompt, as a read-aloud card does, and nothing else: no context, no sentence.
    check(
      'questions_shape_valid',
      sql`case ${t.type}
        when 'multiple_choice' then ${t.options} is not null and ${t.prompt} is null and ${t.alternatives} is null and ${t.tiles} is null
        when 'new_meaning' then ${t.options} is not null and ${t.prompt} is null and ${t.alternatives} is null and ${t.tiles} is null
        when 'listen_choice' then ${t.options} is not null and ${t.prompt} is null and ${t.alternatives} is null and ${t.tiles} is null
        when 'matching' then ${t.options} is not null and ${t.prompt} is null and ${t.alternatives} is null and ${t.tiles} is null
        when 'reverse_choice' then ${t.options} is not null and ${t.prompt} is not null and ${t.alternatives} is null and ${t.tiles} is null
        when 'typed_translation' then ${t.options} is null and ${t.prompt} is not null and ${t.tiles} is null
          and ${t.alternatives} is not null and coalesce(array_length(${t.alternatives}, 1), 0) <= 10
        when 'dictation' then ${t.options} is null and ${t.prompt} is not null and ${t.alternatives} is null and ${t.tiles} is null
        when 'letter_tiles' then ${t.options} is null and ${t.prompt} is not null and ${t.alternatives} is null
          and coalesce(array_length(${t.tiles}, 1), 0) between 5 and 12
        when 'read_aloud' then ${t.options} is null and ${t.prompt} is not null and ${t.alternatives} is null and ${t.tiles} is null
        when 'say_translation' then ${t.options} is null and ${t.prompt} is not null and ${t.tiles} is null
          and ${t.alternatives} is not null and coalesce(array_length(${t.alternatives}, 1), 0) <= 10
        when 'typed_meaning' then ${t.options} is null and ${t.prompt} is not null and ${t.alternatives} is null and ${t.tiles} is null
        when 'cloze_choice' then ${t.options} is not null and ${t.prompt} is not null and ${t.alternatives} is null and ${t.tiles} is null
        when 'cloze_typed' then ${t.options} is null and ${t.prompt} is not null and ${t.tiles} is null
          and ${t.alternatives} is not null and coalesce(array_length(${t.alternatives}, 1), 0) <= 10
        when 'sentence_translation' then ${t.options} is null and ${t.prompt} is not null and ${t.alternatives} is null and ${t.tiles} is null
        when 'meet' then ${t.options} is null and ${t.prompt} is not null and ${t.alternatives} is null and ${t.tiles} is null
        else false end
        and (${t.type} in ('typed_translation', 'say_translation', 'reverse_choice', 'typed_meaning', 'multiple_choice', 'new_meaning')
          or (${t.context} is null and ${t.contextTranslation} is null
            and ${t.contextMarkStart} is null and ${t.contextMarkEnd} is null))
        and (${t.type} in ('cloze_typed', 'sentence_translation')
          or (${t.sentenceMarkStart} is null and ${t.sentenceMarkEnd} is null))`,
    ),
    // Phase 39 (spec D6). The card records the meanings it showed: some on a
    // new_meaning, none on any other type. A new_meaning card also carries a context
    // (the new meaning's example), as a multiple choice does.
    check(
      'questions_known_meanings_valid',
      sql`(${t.type} = 'new_meaning') = (${t.knownMeanings} is not null and cardinality(${t.knownMeanings}) > 0)`,
    ),
    // Phase 34 (spec D6, D8). A mark names both ends or neither, and lies inside the
    // sentence it marks; a context's translation and mark need a context. Null marks
    // are valid: the word could not be found, and the sentence is shown unmarked.
    check(
      'questions_marks_valid',
      sql`(${t.contextMarkStart} is null) = (${t.contextMarkEnd} is null)
        and (${t.sentenceMarkStart} is null) = (${t.sentenceMarkEnd} is null)
        and (${t.contextTranslation} is null or ${t.context} is not null)
        and (${t.contextMarkStart} is null or (${t.context} is not null and ${t.contextMarkStart} >= 0
          and ${t.contextMarkStart} < ${t.contextMarkEnd} and ${t.contextMarkEnd} <= length(${t.context})))
        and (${t.sentenceMarkStart} is null or (${t.sentenceTranslation} is not null and ${t.sentenceMarkStart} >= 0
          and ${t.sentenceMarkStart} < ${t.sentenceMarkEnd} and ${t.sentenceMarkEnd} <= length(${t.sentenceTranslation})))`,
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
    foreignKey({ name: 'questions_gloss_fk', columns: [t.glossId], foreignColumns: [dictGlosses.id] }),
    check('questions_owner_complete', sql`(${t.userId} is null) = (${t.enrollmentId} is null)`),
  ],
);

/**
 * Phase 39 (spec D4). A family of two or more glosses of one lexeme in one
 * enrollment, recorded so that it can be traced. The rule is derived on every
 * session creation; these tables hold what it decided.
 */
export const glossFamilies = pgTable(
  'gloss_families',
  {
    id: text('id').primaryKey(),
    enrollmentId: text('enrollment_id')
      .notNull()
      .references(() => enrollments.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('gloss_families_enrollment_idx').on(t.enrollmentId)],
);

/**
 * Phase 39 (spec D4). One row per saved gloss in a family. Keyed and referenced
 * as gloss_progress is: through its vocabulary entry, so ADR 0011 holds and an
 * unsaved gloss takes its row with it.
 */
export const glossFamilyMembers = pgTable(
  'gloss_family_members',
  {
    enrollmentId: text('enrollment_id').notNull(),
    glossId: text('gloss_id').notNull(),
    familyId: text('family_id')
      .notNull()
      .references(() => glossFamilies.id, { onDelete: 'cascade' }),
    state: text('state').notNull(),
    position: integer('position').notNull(),
    // Phase 39's known_at. Since phase 46 (spec D4) neither read nor written: the
    // gloss's own vocabulary_entries.known_at took its place. It stays only because
    // the old container still names it for its rollout minute (ADR 0010); a later
    // phase drops it.
    knownAt: timestamp('known_at', { withTimezone: true }),
    since: timestamp('since', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'gloss_family_members_pkey', columns: [t.enrollmentId, t.glossId] }),
    foreignKey({
      name: 'gloss_family_members_entry_fk',
      columns: [t.enrollmentId, t.glossId],
      foreignColumns: [vocabularyEntries.enrollmentId, vocabularyEntries.glossId],
    })
      .onDelete('cascade')
      .onUpdate('cascade'),
    check('gloss_family_members_state_known', sql`${t.state} in ('known', 'current', 'waiting')`),
    index('gloss_family_members_family_idx').on(t.familyId),
  ],
);

/**
 * Phase 39 (spec D4). Append-only: every change of a member and why. family_id and
 * gloss_id carry no foreign key, so the log outlives a dissolved family and an
 * unsaved gloss.
 */
export const glossFamilyEvents = pgTable(
  'gloss_family_events',
  {
    id: text('id').primaryKey(),
    enrollmentId: text('enrollment_id')
      .notNull()
      .references(() => enrollments.id, { onDelete: 'cascade' }),
    familyId: text('family_id').notNull(),
    glossId: text('gloss_id').notNull(),
    sessionId: text('session_id').notNull(),
    fromState: text('from_state'),
    toState: text('to_state'),
    evidence: jsonb('evidence').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('gloss_family_events_enrollment_at_idx').on(t.enrollmentId, t.at)],
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
    // enrollment's saved glosses.
    source: text('source').notNull(),
    // Phase 35 (spec D10). The learner's day the session counts for, set from
    // services/learnerDay.ts in the transaction that ends it; null until then.
    practiceDay: date('practice_day', { mode: 'string' }),
    // Phase 43 (spec D1). When the session was started: by its start call or its
    // first answer, whichever came first; never cleared. Null for a session
    // nobody has started, which an open one in stock is.
    startedAt: timestamp('started_at', { withTimezone: true }),
    // Phase 43 (spec D1). What the session was built for: a device with a voice
    // for the target, and one that can record. Every insert here says which;
    // the default is for the code before this phase, which the old container
    // still runs for a minute after the new one migrates (ADR 0010).
    listening: boolean('listening').notNull().default(false),
    speaking: boolean('speaking').notNull().default(false),
    // Phase 53 (spec D12). The learner day a list session's words were chosen,
    // which the stale-stock check compares with today's: a stock chosen on an
    // earlier day is replaced when the day's split no longer matches the one in
    // session_targets. Null for a seed and for every session before this phase.
    chosenOn: date('chosen_on', { mode: 'string' }),
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
    // Phase 43 (spec D1). Phase 19's one-open-session rule, split by started_at:
    // one open session in stock and one started, per enrollment. A concurrent
    // second of either fails here and becomes a 409, which no read-then-insert
    // check could promise.
    uniqueIndex('sessions_one_stock_per_enrollment')
      .on(t.enrollmentId)
      .where(sql`${t.status} in ('preparing', 'ready') and ${t.startedAt} is null`),
    uniqueIndex('sessions_one_started_per_enrollment')
      .on(t.enrollmentId)
      .where(sql`${t.status} = 'ready' and ${t.startedAt} is not null`),
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
    // Phase 34 (spec D9). A right answer that is not the saved word keeps the card
    // open for one more try. `pending` holds the session where it is; `resolved`
    // has the retry's text and verdict. Null on every other answer.
    retryState: text('retry_state'),
    retryText: text('retry_text'),
    retryVerdict: text('retry_verdict'),
    // Phase 38 (spec D4). Whether the learner opened a typed cloze's Hebrew sentence
    // before its first answer. Null on every other card, from an older app, and
    // never changed by a retry.
    hintOpened: boolean('hint_opened'),
    // Phase 55 (spec D6). Whether the learner used help, or placed a wrong tile, on
    // a letter_tiles or typed_translation card before its first answer: a helped
    // answer is stored wrong. Null on every other card, from an older app, and
    // never changed by a retry.
    helped: boolean('helped'),
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
    // Phase 54 (spec D6, D7). A meet card's `seen`, an empty text with this verdict.
    // Not a retry's: a meet card has no second try.
    check(
      'answers_verdict_known',
      sql`${t.verdict} in ('exact', 'near_miss', 'alternative', 'wrong', 'understood', 'gave_up', 'skipped', 'seen')`,
    ),
    // Phase 27 (spec D11): a judged answer is at most 300 characters.
    check('answers_typed_text_length', sql`length(${t.typedText}) <= 300`),
    // Phase 38 (spec D4). A hint is opened before a typed answer, never a choice.
    check('answers_hint_opened_typed', sql`${t.hintOpened} is null or ${t.typedText} is not null`),
    // Phase 55 (spec D6). Help is given on a typed answer, never a choice.
    check('answers_helped_text', sql`${t.helped} is null or ${t.typedText} is not null`),
    // Phase 34 (spec D9). A retry exists only after an `alternative` verdict, so a
    // choice answer, whose verdict is null, never has one: `is true` and not a bare
    // `=`, because a CHECK passes on null. Its text and verdict are set exactly when
    // it is resolved, and judged as the first answer is.
    check('answers_retry_state_known', sql`${t.retryState} in ('pending', 'resolved')`),
    check(
      'answers_retry_only_on_alternative',
      sql`${t.retryState} is null or (${t.verdict} = 'alternative') is true`,
    ),
    check(
      'answers_retry_resolved_complete',
      sql`(${t.retryState} is not distinct from 'resolved') = (${t.retryText} is not null)
        and (${t.retryState} is not distinct from 'resolved') = (${t.retryVerdict} is not null)`,
    ),
    check(
      'answers_retry_verdict_known',
      sql`${t.retryVerdict} in ('exact', 'near_miss', 'alternative', 'wrong', 'understood', 'gave_up', 'skipped')`,
    ),
    check('answers_retry_text_length', sql`length(${t.retryText}) <= 300`),
  ],
);

/**
 * Phase 20, keyed on the gloss since phase 31. What one ended session did to
 * each progress row of each saved gloss it practised: all five dimensions,
 * moved or not. It is what lets the results be read again after the session
 * ended, and what the recompute rebuilds. No FK to gloss_progress: on the live
 * path a gloss unsaved later keeps its history here, and the results of an old
 * session still read. A recompute rebuilds only what the current saves can
 * explain, so it drops the rows of a gloss unsaved since.
 */
export const sessionProgress = pgTable(
  'session_progress',
  {
    sessionId: uuid('session_id').notNull(),
    glossId: text('gloss_id').notNull(),
    dimension: text('dimension').notNull(),
    levelBefore: integer('level_before').notNull(),
    levelAfter: integer('level_after').notNull(),
  },
  (t) => [
    primaryKey({ name: 'session_progress_pkey', columns: [t.sessionId, t.glossId, t.dimension] }),
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
 * saveable glosses as a snapshot (`options`), the gloss the job chose
 * (`suggested_gloss_id`, never changed after) and the learner's choice. Phase
 * 31 re-keyed both on the gloss (spec D15).
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
    suggestedGlossId: text('suggested_gloss_id'),
    chosenGlossId: text('chosen_gloss_id'),
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
    check('photo_import_items_tick_needs_gloss', sql`not ${t.ticked} or ${t.chosenGlossId} is not null`),
  ],
);

// Phase 47 (spec D2). One row per request to a model, whatever its outcome:
// what was sent, what came back and how long it took, so a prompt can be
// read, replayed and measured afterwards. A log, not part of the data model:
// no foreign keys, so a record never fails on a session a reseed deleted
// mid-call and never holds back a deletion (ruling R2), and no check on
// `kind`, whose values are the server's ModelCallKind. Kept 7 days: each
// record deletes what is older (ruling R3).
export const modelCalls = pgTable(
  'model_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    kind: text('kind').notNull(),
    model: text('model').notNull(),
    sessionId: uuid('session_id'),
    attempt: integer('attempt'),
    enrollmentId: text('enrollment_id'),
    userId: text('user_id'),
    // The body as sent, with audio and image data replaced by their type and
    // size; the key travels in a header and is never here.
    request: jsonb('request').notNull(),
    // The body as received; null when none arrived (a timeout, a network failure).
    response: jsonb('response'),
    httpStatus: integer('http_status'),
    // The message LlmUnavailable carries, when the call failed.
    error: text('error'),
    durationMs: integer('duration_ms').notNull(),
    // From the response's usageMetadata, so they count without reading the JSON.
    promptTokens: integer('prompt_tokens'),
    outputTokens: integer('output_tokens'),
    thinkingTokens: integer('thinking_tokens'),
    finishReason: text('finish_reason'),
  },
  (t) => [
    index('model_calls_session_idx').on(t.sessionId, t.startedAt),
    index('model_calls_enrollment_idx').on(t.enrollmentId, t.startedAt),
    index('model_calls_user_idx').on(t.userId, t.startedAt),
    index('model_calls_kind_idx').on(t.kind, t.startedAt),
    index('model_calls_started_idx').on(t.startedAt),
  ],
);

// Phase 50 (spec D3). How alike two words sound in a language, 0 to 1, asked
// of a model once per pair and shared by every learner of the language: the
// second look an unheard transcript gets. The score is stored, not a verdict,
// so a new threshold applies to every row with no call. Keyed by what a
// learner said, not by a dictionary entry, so it is no dict_ table, and
// db:reseed leaves it alone. `form_a < form_b`: (sell, cell) and (cell, sell)
// are one row. Written ON CONFLICT DO NOTHING: the first score stands.
export const pronunciationScores = pgTable(
  'pronunciation_scores',
  {
    languageCode: varchar('language_code', { length: 10 }).notNull(),
    formA: text('form_a').notNull(),
    formB: text('form_b').notNull(),
    score: real('score').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pronunciation_scores_pkey', columns: [t.languageCode, t.formA, t.formB] }),
    // "C": byte order, which is the code-point order orderedPair uses. The
    // database's own collation could order a pair the other way.
    check('pronunciation_scores_ordered', sql`${t.formA} < ${t.formB} collate "C"`),
    check('pronunciation_scores_form_a_length', sql`length(${t.formA}) between 1 and 100`),
    check('pronunciation_scores_form_b_length', sql`length(${t.formB}) between 1 and 100`),
    check('pronunciation_scores_score_range', sql`${t.score} between 0 and 1`),
  ],
);

// Phase 52 (spec D2). A learner's reminder schedule: one row, written whole by
// PUT /api/me/reminders. A learner with no row has the defaults, which live in
// one constant, DEFAULT_REMINDER_SETTINGS in domain/reminders.ts, so there is
// no column default to keep in step with it. `days` are ISO weekdays (1 =
// Monday), `times` are 'HH:MM' on the learner's clock; the service keeps both
// sorted and distinct.
export const reminderSettings = pgTable('reminder_settings', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull(),
  dailyTarget: smallint('daily_target').notNull(),
  days: smallint('days').array().notNull(),
  times: text('times').array().notNull(),
  updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
});

// Phase 52 (spec D4). One row per Expo push token. A token is a phone, not a
// person: when a second account signs in on the same phone it registers the
// same token, and the row moves to them (repo/reminders.ts upsertDevice).
export const pushDevices = pgTable(
  'push_devices',
  {
    token: text('token').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', tz).notNull().defaultNow(),
  },
  (t) => [index('push_devices_user_idx').on(t.userId)],
);

// Phase 52 (spec D6). One row per decision about one slot of one learner's day:
// the log that says what a tick decided and why, and what came of it (tickets,
// receipts, the tap, the session). `outcome` starts as 'claimed' in the write
// that wins the slot and is replaced by the result; a row left 'claimed' is a
// slot whose send never landed. `session_id` carries no foreign key, so the log
// outlives the session, as gloss_family_events does. `local_day` is a date on
// the learner's clock (domain/learnerClock.ts); `slot` is 'HH:MM'. Unique on
// (user_id, local_day, slot) is what makes a claim decide a slot once.
export const reminders = pgTable(
  'reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    localDay: date('local_day', { mode: 'string' }).notNull(),
    slot: text('slot').notNull(),
    decidedAt: timestamp('decided_at', tz).notNull().defaultNow(),
    outcome: text('outcome').notNull(),
    evidence: jsonb('evidence').notNull().default(sql`'{}'::jsonb`),
    tickets: jsonb('tickets'),
    receipts: jsonb('receipts'),
    receiptsCheckedAt: timestamp('receipts_checked_at', tz),
    tappedAt: timestamp('tapped_at', tz),
    sessionId: text('session_id'),
  },
  (t) => [
    unique('reminders_user_day_slot_key').on(t.userId, t.localDay, t.slot),
    check('reminders_outcome_known', sql`${t.outcome} in ('claimed', 'sent', 'skip_target_met', 'failed')`),
    index('reminders_user_day_idx').on(t.userId, t.localDay),
  ],
);

// Phase 53 (spec D1). A learner's preparation for homework or a test: a kind, a
// due date and words (target_words). `due_on` is a learner day (ADR 0013). A
// target is active while today is before `due_on` and `ended_at` is null: on
// `due_on` it ends by itself and nothing is written for that, bar the
// `ended_on_date` event the first session chosen after it records (D8).
// `ended_at` is the learner ending it early. The kind is a fact the picker reads
// (domain/targets.ts TARGET_KINDS), never a skill filter (D3).
export const targets = pgTable(
  'targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    enrollmentId: text('enrollment_id').notNull(),
    kind: text('kind').notNull(),
    dueOn: date('due_on', { mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    endedAt: timestamp('ended_at', tz),
  },
  (t) => [
    foreignKey({ name: 'targets_enrollment_fk', columns: [t.enrollmentId], foreignColumns: [enrollments.id] }),
    check('targets_kind_known', sql`${t.kind} in ('homework', 'exam')`),
    // The picker's read on every session: one enrollment's targets by date.
    index('targets_enrollment_due_idx').on(t.enrollmentId, t.dueOn),
  ],
);

// Phase 53 (spec D1). A gloss in a target. A target word is always a saved word,
// and the service keeps that true, not the schema: unsaving a word removes it from
// every target (repo/targets.ts removeGlossFromTargets), and a gloss merge moves it
// to the survivor (repo/glosses.ts mergeGlosses). The key is on dict_glosses because
// ADR 0011 has every learner table hold a gloss.
export const targetWords = pgTable(
  'target_words',
  {
    targetId: uuid('target_id').notNull(),
    glossId: text('gloss_id').notNull(),
    addedAt: timestamp('added_at', tz).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'target_words_pkey', columns: [t.targetId, t.glossId] }),
    foreignKey({ name: 'target_words_target_fk', columns: [t.targetId], foreignColumns: [targets.id] }).onDelete('cascade'),
    foreignKey({ name: 'target_words_gloss_fk', columns: [t.glossId], foreignColumns: [dictGlosses.id] }),
    // Unsaving and a merge both find a gloss's targets.
    index('target_words_gloss_idx').on(t.glossId),
  ],
);

// Phase 53 (spec D8). Append-only: every change of a target, with the values
// before and after and who made it. `session_id` is the session whose choosing
// recorded `ended_on_date`; it and `actor_user_id` carry no foreign key, so the
// log outlives both, as gloss_family_events does. `before` and `after` are the
// service's own shapes, per kind.
export const targetEvents = pgTable(
  'target_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetId: uuid('target_id').notNull(),
    kind: text('kind').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    actorUserId: text('actor_user_id'),
    sessionId: uuid('session_id'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'target_events_target_fk', columns: [t.targetId], foreignColumns: [targets.id] }).onDelete('cascade'),
    check(
      'target_events_kind_known',
      sql`${t.kind} in ('created', 'words_added', 'words_removed', 'date_changed', 'ended_early', 'ended_on_date')`,
    ),
    index('target_events_target_created_idx').on(t.targetId, t.createdAt),
  ],
);

// Phase 53 (spec D8). One row per session and target it served: what the target
// wished, the slots it was given, how many words came from it, why (a ShareReason
// of domain/targets.ts) and the readiness the wish came from. Written in the
// transaction that chooses the session's words; read back only by the stale-stock
// check (D12). Nothing ties `picked` to `slots`: a target is handed slots the main
// path could not use in a second pass, so it can pick more than it was given.
export const sessionTargets = pgTable(
  'session_targets',
  {
    sessionId: uuid('session_id').notNull(),
    targetId: uuid('target_id').notNull(),
    wish: integer('wish').notNull(),
    slots: integer('slots').notNull(),
    picked: integer('picked').notNull(),
    reason: text('reason').notNull(),
    daysLeft: integer('days_left').notNull(),
    readyCount: integer('ready_count').notNull(),
    wordCount: integer('word_count').notNull(),
  },
  (t) => [
    primaryKey({ name: 'session_targets_pkey', columns: [t.sessionId, t.targetId] }),
    foreignKey({ name: 'session_targets_session_fk', columns: [t.sessionId], foreignColumns: [sessions.id] }).onDelete('cascade'),
    foreignKey({ name: 'session_targets_target_fk', columns: [t.targetId], foreignColumns: [targets.id] }).onDelete('cascade'),
    check('session_targets_reason_known', sql`${t.reason} in ('exclusive', 'run_up', 'not_ready', 'steady')`),
  ],
);
