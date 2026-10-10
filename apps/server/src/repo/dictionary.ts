import type { TranslationKind, TranslationSense } from '@lang-tutor/core/api';
import { normaliseGloss } from '@lang-tutor/core/domain';
import { and, asc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { RepairWouldDropSense } from '../errors';
import {
  dictCorrections,
  dictGlosses,
  dictLemmaRenders,
  dictSenseGlosses,
  dictVarTranslations,
  dictVariantRenderings,
  dictVariants,
  dictLexemes,
  dictSenses,
} from '../db/schema';
import {
  entriesToRows,
  rowsToCards,
  staleLexemes,
  type EntryRows,
  type EntryToStore,
  type Rendering,
  type SenseRow,
  type StaleLexeme,
} from '../domain/dictionary';
import { assignGlosses, type AnswerSense } from '../domain/glosses';
import type { LanguageCode } from '../domain/languages';
import type { GlossRendering } from '../domain/session';
import { tidyAlternatives, type StoredSense } from '../domain/translation';

export type PersistEntriesInput = {
  /** The queried string, already normalized. Stored as written; matched lower. */
  form: string;
  languageCode: string;
  userLanguageCode: string;
  kind: TranslationKind;
  entries: EntryToStore[];
  /** Phase 31 (spec D12). Where this write's entry ranks start: past the form's
   *  existing headwords, for one added to a form already written. 0 otherwise. */
  entryRankOffset?: number;
};

/** What one entry became. `senseIds` is this entry's senses in the order the
 *  entry listed them — whether this call wrote them or found them already
 *  there. Not the lexeme's order, which no longer exists: a sense is ranked per
 *  form, on the translation. */
export type PersistedEntry = {
  lemma: string;
  lexemeId: string;
  variantId: string;
  senseIds: string[];
  /** Phase 31. Each sense's gloss in this write's language, aligned with senseIds. */
  glossIds: string[];
  created: boolean;
};

/** Phase 31. One lexeme in one learner language: what a merge, a lemma render
 *  and its request are each about. */
export type LexemeLanguage = { lexemeId: string; userLanguageCode: string };

export type MergePair = LexemeLanguage;

/** Phase 31 (spec D19). What a write's gloss step did, for `dict_glosses_assigned`:
 *  glosses created, senses that joined an existing gloss, memberships written. */
export type GlossCounts = { created: number; joined: number; members: number };

/** One stored redirect. `typedForm` comes back as it was written, so a caller
 *  that echoes it shows the learner what the dictionary actually holds. */
export type CorrectionRow = {
  typedForm: string;
  correctedForm: string;
  alternatives: string[];
};

/** One rendering a repair produces: what the lookup writes, by sense id. */
export type RepairedRendering = Rendering & { senseId: string };

export function createDictRepo(tx: Tx) {
  /**
   * Four tables, driven by the unique index's (language_code, lower(form))
   * prefix. The join back to `dict_lexemes` is here again — phase 10 removed it
   * because nothing on the lexeme was needed, and phase 12 put `part_of_speech`
   * there, which is what stops `booked` answering with the noun's senses.
   *
   * The inner join to `dict_var_translations` *is* the servability test, and
   * from phase 12 it carries `variant_id`, so what it tests is sharper: not
   * "this lexeme has a translation" but **"this form has its own renderings"**.
   * A form whose lexeme is full of senses it never rendered returns zero rows
   * and is a miss, which is exactly right — it has never been looked up.
   *
   * `(tr.rank, v.entry_rank)` is unique across one form's rows and `v.lexeme_id`
   * closes it, so identical requests return identical answers — the same
   * senses in the same order — until its lexeme learns a new sense, at which
   * point that form re-renders and re-ranks once (phase 12, Task 13). This read is what
   * both the plain hit and the repaired hit answer with.
   *
   * Phase 31 (spec D15). It returns every rendering of the form, each with its
   * gloss's key and its own alternatives: the database has no five limit, and
   * neither has this read. The five-card cap is `rowsToCards`', applied after
   * grouping, so a gloss can never hide behind a row cap (`stream`'s seven rows
   * are five glosses and show five cards). A form renders a handful of senses
   * per lexeme, so the read stays small.
   */
  const findSensesByForm = async (input: {
    form: string;
    languageCode: string;
    userLanguageCode: string;
  }): Promise<SenseRow[]> =>
    tx
      .select({
        lexemeId: dictVariants.lexemeId,
        senseId: dictSenses.id,
        glossId: dictSenseGlosses.glossId,
        variantId: dictVariants.id,
        rank: dictVarTranslations.rank,
        entryRank: dictVariants.entryRank,
        partOfSpeech: dictLexemes.partOfSpeech,
        exampleSource: dictVarTranslations.exampleSource,
        translation: dictVarTranslations.translation,
        exampleTarget: dictVarTranslations.exampleTarget,
        // `dict_variants.kind` is `text`, not a typed enum column, so it comes
        // back untyped from Drizzle; cast rather than widen `SenseRow.kind`,
        // since the write (below) already only ever stores a `TranslationKind`.
        kind: sql<TranslationKind>`${dictVariants.kind}`,
        glossKey: dictGlosses.key,
        alternatives: dictVarTranslations.alternatives,
      })
      .from(dictVariants)
      .innerJoin(dictLexemes, eq(dictLexemes.id, dictVariants.lexemeId))
      .innerJoin(dictSenses, eq(dictSenses.lexemeId, dictVariants.lexemeId))
      .innerJoin(
        dictVarTranslations,
        and(
          eq(dictVarTranslations.variantId, dictVariants.id),
          eq(dictVarTranslations.senseId, dictSenses.id),
          eq(dictVarTranslations.userLanguageCode, input.userLanguageCode),
        ),
      )
      // Phase 31 (spec D8). Every rendered sense has its gloss in this language.
      .innerJoin(
        dictSenseGlosses,
        and(eq(dictSenseGlosses.senseId, dictSenses.id), eq(dictSenseGlosses.userLanguageCode, input.userLanguageCode)),
      )
      .innerJoin(dictGlosses, eq(dictGlosses.id, dictSenseGlosses.glossId))
      .where(
        and(
          eq(dictVariants.languageCode, input.languageCode),
          // lower(form), matching the index expression exactly so the index is
          // usable. Hebrew has no case, so this is a no-op on that side.
          sql`lower(${dictVariants.form}) = ${input.form.toLowerCase()}`,
        ),
      )
      // Rank still leads, so the merge across lexemes is still round-robin
      // rather than block-per-entry: ordering by entry first would put both of
      // `book`'s noun senses ahead of either verb sense. What changed is only
      // whose rank it is — this form's own, not the lexeme's.
      .orderBy(
        asc(dictVarTranslations.rank),
        asc(dictVariants.entryRank),
        asc(dictVariants.lexemeId),
      );

  /**
   * One indexed lookup on `(language_code, lower(typed_form))` — the same
   * matching rule `dict_variants` uses, and the same expression the unique index
   * is built on, so the index is usable.
   *
   * Read only on a MISS path, which is what makes it free: a correctly spelled
   * word resolves before this is ever called, and a lookup that reaches it is
   * already paying for a provider call measured in seconds.
   */
  const findCorrectionByForm = async (input: {
    form: string;
    languageCode: string;
  }): Promise<CorrectionRow | undefined> => {
    const [row] = await tx
      .select({
        typedForm: dictCorrections.typedForm,
        correctedForm: dictCorrections.correctedForm,
        alternatives: dictCorrections.alternatives,
      })
      .from(dictCorrections)
      .where(
        and(
          eq(dictCorrections.languageCode, input.languageCode),
          sql`lower(${dictCorrections.typedForm}) = ${input.form.toLowerCase()}`,
        ),
      )
      .limit(1);
    return row;
  };

  /**
   * First-writer-wins, like every other write in this dictionary.
   *
   * **The DO NOTHING is bare here, unlike the two in `persistEntries`, and that is
   * a decision rather than a shortcut.** Those two name their conflict target
   * because a bare clause would also swallow a collision on
   * `dict_variants_form_entry_rank_key` or on
   * `UNIQUE(variant_id, user_language_code, rank)` — safety nets that must be
   * allowed to raise. This table has exactly ONE unique index and no primary key,
   * so the only conflict a bare clause can swallow is the one it is meant to. A
   * CHECK violation is not a conflict and still raises, which is what makes the
   * three constraints a real backstop for `dict:restore`.
   *
   * Three ordinary paths write a redirect for a form that already has one: a
   * step-3 fall-through, two learners missing the same typo concurrently, and a
   * restore replayed onto a database that already holds part of the file. A raise
   * on any of them is silently destructive, because it rolls `persistEntries` back
   * with it and `translate`'s catch turns the failed write into a 200 — a
   * permanent two-call tax on one typo, appearing as a log line rather than an
   * error. A redirect that raised on a re-restore would also make `dict:restore`
   * non-idempotent for the first time since phase 11.
   *
   * **`tidyAlternatives` is applied AGAIN here**, so the three-item cap and the
   * dedupe are properties of the write rather than of one caller: `dict:restore`
   * reaches this function without passing through `domain/` at all. Idempotent, so
   * the second application costs nothing on the live path.
   */
  const persistCorrection = async (input: {
    typedForm: string;
    correctedForm: string;
    alternatives: string[];
    languageCode: string;
  }): Promise<void> => {
    await tx
      .insert(dictCorrections)
      .values({
        languageCode: input.languageCode,
        typedForm: input.typedForm,
        correctedForm: input.correctedForm,
        alternatives: tidyAlternatives(input.alternatives, {
          correctedForm: input.correctedForm,
          typedForm: input.typedForm,
        }),
      })
      .onConflictDoNothing();
  };

  /**
   * One row per lexeme this form belongs to that has been rendered in
   * `userLanguageCode`, carrying both versions. INNER join, not LEFT: a variant
   * with no rendering in this language is never served in it, so it has nothing
   * to repair from, and calling it stale would buy a model call that can only
   * come back empty (plan deviation 2).
   */
  const findStaleLexemesByForm = async (input: {
    form: string;
    languageCode: string;
    userLanguageCode: string;
  }): Promise<StaleLexeme[]> =>
    staleLexemes(
      await tx
        .select({
          lexemeId: dictVariants.lexemeId,
          variantId: dictVariants.id,
          lemma: dictLexemes.lemma,
          partOfSpeech: dictLexemes.partOfSpeech,
          senseVersion: dictLexemes.senseVersion,
          renderedSenseVersion: dictVariantRenderings.renderedSenseVersion,
        })
        .from(dictVariants)
        .innerJoin(dictLexemes, eq(dictLexemes.id, dictVariants.lexemeId))
        .innerJoin(
          dictVariantRenderings,
          and(
            eq(dictVariantRenderings.variantId, dictVariants.id),
            eq(dictVariantRenderings.userLanguageCode, input.userLanguageCode),
          ),
        )
        .where(
          and(
            eq(dictVariants.languageCode, input.languageCode),
            sql`lower(${dictVariants.form}) = ${input.form.toLowerCase()}`,
          ),
        ),
    );

  /**
   * The stored senses of one lexeme, for the reconciliation prompt. Keyed by
   * (lemma, part_of_speech) rather than by id because the service has only what
   * the first model call returned — it does not know the lexeme id, and may find
   * there is no such lexeme at all.
   *
   * **One gloss per sense, taken from whichever variant has one — never from a
   * chosen variant.** Two traps here, and both are silent:
   *
   * `entry_rank` is NOT a property of the lexeme. `entriesToRows` assigns it from
   * the entry's index in the answer for one queried form, so the verb lexeme of
   * `book` sits at entry_rank 1 and owns no entry_rank 0 variant at all.
   * Filtering on `entryRank = 0` would return zero rows for it, the service would
   * conclude the lexeme has no senses, and reconciliation would be skipped for
   * exactly the lexemes it exists for — verbs, which is what inflections mostly
   * are.
   *
   * And because a rendering may be absent for a form (the reconciliation call
   * returns `translation: null` for a sense a form does not admit), no single
   * variant is guaranteed to carry a gloss for every sense. A sense missing from
   * the prompt gets a freshly invented code — the same duplication by another
   * route.
   *
   * `DISTINCT ON (s.id)` with `ORDER BY s.id, tr.rank, v.id` is what makes the
   * pick deterministic: the gloss from whichever form ranked that sense highest,
   * ties broken by variant id. The outer query then re-orders for the prompt.
   *
   * Phase 31 (spec D9). No longer INNER-joined to the learner's language: a
   * language with no renderings yet still lists every sense, with its
   * definition and a gloss in some other language, so the second call runs and
   * reuses codes instead of the lexeme growing a second set of senses. The
   * learner's own rendering is preferred where there is one.
   */
  const findSensesByLexeme = async (input: {
    lemma: string;
    partOfSpeech: string;
    languageCode: string;
    userLanguageCode: string;
  }): Promise<(StoredSense & { senseId: string })[]> => {
    // Drizzle has no first-class DISTINCT ON, so this is written as `sql`. The
    // shape is the invariant, not the spelling: one row per sense, chosen
    // deterministically, over ALL variants of the lexeme.
    const rows = await tx.execute<{
      sense_id: string;
      sense_code: string;
      definition: string | null;
      translation: string;
      gloss_language: string;
      example_source: string | null;
      example_target: string | null;
    }>(sql`
      SELECT sense_id, sense_code, definition, translation, gloss_language, example_source, example_target
      FROM (
        SELECT DISTINCT ON (s.id)
               s.id                   AS sense_id,
               s.sense_code           AS sense_code,
               s.definition           AS definition,
               tr.translation,
               tr.user_language_code  AS gloss_language,
               tr.example_source,
               tr.example_target,
               tr.rank                AS rank,
               (tr.user_language_code = ${input.userLanguageCode}) AS own
        FROM dict_lexemes l
        JOIN dict_senses s            ON s.lexeme_id = l.id
        JOIN dict_var_translations tr ON tr.sense_id = s.id
        JOIN dict_variants v          ON v.id = tr.variant_id
        WHERE l.language_code = ${input.languageCode}
          AND l.lemma = ${input.lemma}
          AND l.part_of_speech = ${input.partOfSpeech}
        ORDER BY s.id, (tr.user_language_code = ${input.userLanguageCode}) DESC, tr.rank, tr.user_language_code, v.id
      ) picked
      ORDER BY own DESC, rank, sense_code
    `);

    return rows.rows.map((row) => ({
      senseId: row.sense_id,
      senseCode: row.sense_code,
      definition: row.definition,
      translation: row.translation,
      glossLanguage: row.gloss_language as LanguageCode,
      exampleSource: row.example_source,
      exampleTarget: row.example_target,
    }));
  };

  /** Phase 31. FOR UPDATE on these lexemes, in id order, in one statement. The
   *  lock step 1b of persistEntries takes, for the repair and the merge too, so a
   *  lookup, a repair and a merge of one lexeme run one after the other (spec D7).
   *  One ordered statement, for the deadlock reason step 1b gives. */
  const lockLexemes = async (lexemeIds: string[]): Promise<void> => {
    const ids = [...new Set(lexemeIds)];
    if (ids.length === 0) return;
    await tx
      .select({ id: dictLexemes.id })
      .from(dictLexemes)
      .where(inArray(dictLexemes.id, ids))
      .orderBy(asc(dictLexemes.id))
      .for('update');
  };

  /**
   * Phase 31 (spec D6, D8). The lexeme's live glosses and memberships in one
   * language, the plan assignGlosses makes from them, and that plan written. Each
   * sense's gloss id comes back in the order given. The caller holds
   * lockLexemes, so no other writer of this lexeme is between the read and the
   * writes.
   */
  const writeGlosses = async (input: {
    lexemeId: string;
    userLanguageCode: string;
    lemmaForm: boolean;
    senses: AnswerSense[];
  }): Promise<{ glossIds: string[]; needsMerge: boolean; counts: GlossCounts }> => {
    const glosses = await tx
      .select({ id: dictGlosses.id, key: dictGlosses.key, alternatives: dictGlosses.alternatives })
      .from(dictGlosses)
      .where(
        and(
          eq(dictGlosses.lexemeId, input.lexemeId),
          eq(dictGlosses.userLanguageCode, input.userLanguageCode),
          isNull(dictGlosses.mergedInto),
        ),
      );
    // Phase 31 (spec D7). A merged gloss's key still names its survivor: a sense
    // that names it later joins the survivor rather than reviving the word.
    const forwarded = await tx
      .select({ key: dictGlosses.key, survivor: dictGlosses.mergedInto })
      .from(dictGlosses)
      .where(
        and(
          eq(dictGlosses.lexemeId, input.lexemeId),
          eq(dictGlosses.userLanguageCode, input.userLanguageCode),
          isNotNull(dictGlosses.mergedInto),
        ),
      );
    const aliases = new Map(forwarded.map((row) => [normaliseGloss(row.key), row.survivor!]));
    const members = await tx
      .select({ senseId: dictSenseGlosses.senseId, glossId: dictSenseGlosses.glossId })
      .from(dictSenseGlosses)
      .where(
        and(eq(dictSenseGlosses.lexemeId, input.lexemeId), eq(dictSenseGlosses.userLanguageCode, input.userLanguageCode)),
      );
    const memberships = new Map(members.map((member) => [member.senseId, member.glossId]));
    const plan = assignGlosses({ senses: input.senses, lemmaForm: input.lemmaForm, glosses, memberships, aliases });

    // Renames first, so a key a rename frees is free for a new gloss of this write.
    for (const rename of plan.rename) {
      await tx.update(dictGlosses).set({ key: rename.key }).where(eq(dictGlosses.id, rename.glossId));
    }
    for (const widened of plan.alternatives) {
      await tx.update(dictGlosses).set({ alternatives: widened.alternatives }).where(eq(dictGlosses.id, widened.glossId));
    }
    const glossBySense = new Map(memberships);
    const added: { senseId: string; glossId: string }[] = [...plan.join];
    for (const fresh of plan.create) {
      const [row] = await tx
        .insert(dictGlosses)
        .values({ lexemeId: input.lexemeId, userLanguageCode: input.userLanguageCode, key: fresh.key, alternatives: fresh.alternatives })
        .returning({ id: dictGlosses.id });
      for (const senseId of fresh.senseIds) added.push({ senseId, glossId: row.id });
    }
    for (const { senseId, glossId } of added) glossBySense.set(senseId, glossId);
    if (added.length > 0) {
      await tx
        .insert(dictSenseGlosses)
        .values(added.map(({ senseId, glossId }) => ({ senseId, glossId, lexemeId: input.lexemeId, userLanguageCode: input.userLanguageCode })))
        .onConflictDoNothing({ target: [dictSenseGlosses.senseId, dictSenseGlosses.userLanguageCode] });
    }
    return {
      glossIds: input.senses.map((sense) => glossBySense.get(sense.senseId)!),
      needsMerge: plan.needsMerge,
      counts: { created: plan.create.length, joined: plan.join.length, members: added.length },
    };
  };

  /**
   * One write, ending in a re-read.
   *
   * **First-writer-wins splits in two in phase 12.** A sense is written once per
   * lexeme — that is step 4, and it is why two lookups of one headword do not
   * accumulate near-duplicate meanings. A *translation* is written once per
   * (variant, sense): step 5. So a second form of a headword the dictionary
   * already knows adds no senses but does add its own renderings of them, which
   * is the whole of the rendering fix. A translation is rewritten only by
   * `repairVariantRenderings`, when its lexeme has learned a sense this form has
   * never rendered — otherwise there is no TTL and no invalidation, which is
   * what makes the concurrent case trivial and is also why a poor answer is
   * served from then on.
   *
   * Which senses an entry names is decided before this function is reached: the
   * reconciliation call in services/translations.ts maps a new form's senses
   * onto the stored ones by meaning, so step 4 only has to be safe under
   * concurrency rather than clever about matching.
   *
   * The concurrent double-miss is handled at step 1 rather than by retry logic:
   * the second transaction blocks on UNIQUE(language_code, lemma,
   * part_of_speech) until the first commits, then finds the senses already there.
   */
  const persistEntries = async (
    input: PersistEntriesInput,
  ): Promise<{ written: PersistedEntry[]; senses: TranslationSense[]; mergePairs: MergePair[]; glosses: GlossCounts }> => {
    const written: PersistedEntry[] = [];
    const mergePairs: MergePair[] = [];
    const glosses: GlossCounts = { created: 0, joined: 0, members: 0 };
    const rows = entriesToRows(input.entries, input.entryRankOffset);

    // 1 — every lexeme of this answer, which is the PAIR of a lemma and a part
    // of speech from phase 12 on. DO NOTHING returns no row, which is exactly
    // how "it was already there" is detected; a concurrent request for the same
    // new lexeme blocks here until the first commits.
    //
    // A pass of its own, ahead of the per-entry loop, so that step 1b below can
    // lock every one of them in a single ordered statement — see the comment
    // there for why the order is the whole point.
    const resolved: { entry: EntryRows; lexemeId: string; created: boolean }[] = [];

    for (const entry of rows) {
      const [inserted] = await tx
        .insert(dictLexemes)
        .values({
          languageCode: input.languageCode,
          lemma: entry.lemma,
          partOfSpeech: entry.partOfSpeech,
        })
        .onConflictDoNothing({
          target: [dictLexemes.languageCode, dictLexemes.lemma, dictLexemes.partOfSpeech],
        })
        .returning({ id: dictLexemes.id });

      let lexemeId = inserted?.id;
      if (!lexemeId) {
        const [existing] = await tx
          .select({ id: dictLexemes.id })
          .from(dictLexemes)
          .where(
            and(
              eq(dictLexemes.languageCode, input.languageCode),
              eq(dictLexemes.lemma, entry.lemma),
              eq(dictLexemes.partOfSpeech, entry.partOfSpeech),
            ),
          );
        lexemeId = existing.id;
      }

      resolved.push({ entry, lexemeId, created: !!inserted });
    }

    // 1b — lock every lexeme this write touches, in ONE statement, ordered by
    // id, before anything below references any of them as a foreign key.
    //
    // **The lock is required** for 4b's recompute to be correct, not merely for
    // style: under READ COMMITTED, an UPDATE that blocks on a locked row
    // re-fetches THAT row once unblocked, but a subquery in its SET list is
    // evaluated once, against the snapshot the statement started with —
    // Postgres documents that the re-evaluation "does not see effects of
    // [concurrent] commands on other rows in the database". So without a lock
    // taken as its own, earlier statement, two overlapping writers computing
    // `count(*) FROM dict_senses` can each miss the other's still-uncommitted
    // insert and both write the same version — sometimes a version LOWER than
    // an already-passed one, since neither writer's count is bounded by the
    // other's. Taking this lock forces the second writer to block until the
    // first commits; every statement after that point runs on a fresh snapshot,
    // per READ COMMITTED, so the recompute at 4b then sees every commit that is
    // not its own.
    //
    // **It is taken BEFORE the per-entry loop** — not per entry inside it —
    // because a lock taken inside the loop is taken in the MODEL's order. That
    // is whatever order the answer listed the lexemes in (`mergeEntries`
    // preserves it), so two concurrent lookups whose answers name the same two
    // lexemes in opposite orders each hold one row the other wants: an ABBA
    // deadlock, measured at 10 of 10 attempts. Reordering the entries is not
    // the fix — `entry_rank` carries the model's order and the answer depends
    // on it — but nothing downstream depends on the order the LOCKS are taken
    // in, so they go in id order, in one statement that cannot interleave with
    // another session's.
    //
    // **And ahead of step 2**, not merely ahead of step 4 as 4b alone would
    // need, because step 2's variant insert and step 4's sense inserts both
    // carry a foreign key to these rows, and an FK check takes an implicit
    // FOR KEY SHARE lock on the row it references. Two sessions can each hold
    // FOR KEY SHARE on the same row at once — that is the point of a shared
    // lock — so if both had already inserted their own variant (or sense)
    // before either tried to upgrade to FOR UPDATE here, each would be waiting
    // on a lock the other already holds: a deadlock again, and one reproduced
    // while building this fix.
    //
    // See `dictionary.stale.test.ts` for the tests that fail on the wrong
    // sense_version if this lock is removed, and with a 40P01 abort if it moves
    // back inside the loop.
    await lockLexemes(resolved.map((row) => row.lexemeId));

    for (const { entry, lexemeId, created } of resolved) {
      // 2 — the variant, for the queried form only. The conflict target is
      // named rather than left bare: a bare DO NOTHING would also swallow a
      // collision on (language_code, lower(form), entry_rank), which is the
      // safety net and must be allowed to raise.
      await tx
        .insert(dictVariants)
        .values({
          lexemeId,
          languageCode: input.languageCode,
          form: input.form,
          kind: input.kind,
          entryRank: entry.entryRank,
        })
        .onConflictDoNothing({ target: [dictVariants.lexemeId, dictVariants.form] });

      const [variant] = await tx
        .select({ id: dictVariants.id })
        .from(dictVariants)
        .where(and(eq(dictVariants.lexemeId, lexemeId), eq(dictVariants.form, input.form)));

      // 3 — the lexeme's senses, by code. `sense_code` is the only key that can
      // attach a new form's translations to senses this lexeme already has;
      // phase 12 is where it stops being decoration.
      const existing = await tx
        .select({ id: dictSenses.id, senseCode: dictSenses.senseCode })
        .from(dictSenses)
        .where(eq(dictSenses.lexemeId, lexemeId));

      const idByCode = new Map(existing.map((row) => [row.senseCode, row.id]));

      // 4 — an idempotent upsert, not a match. By the time entries reach the
      // repository, the reconciliation call in services/translations.ts has
      // already decided which codes are reused and which are new, so this only
      // has to be safe under concurrency. No rank is assigned here: a sense has
      // no order of its own, only a position within a given form's answer.
      const senseIds: string[] = [];
      for (const sense of entry.senses) {
        let id = idByCode.get(sense.senseCode);
        if (!id) {
          await tx
            .insert(dictSenses)
            .values({ lexemeId, senseCode: sense.senseCode, definition: sense.definition })
            .onConflictDoNothing({ target: [dictSenses.lexemeId, dictSenses.senseCode] });
          const [row] = await tx
            .select({ id: dictSenses.id })
            .from(dictSenses)
            .where(
              and(eq(dictSenses.lexemeId, lexemeId), eq(dictSenses.senseCode, sense.senseCode)),
            );
          id = row.id;
          idByCode.set(sense.senseCode, id);
        }
        // Phase 31 (spec D9). The first definition offered stays: a sense written
        // before the phase, or by a call that gave none, takes this one.
        if (sense.definition !== null) {
          await tx
            .update(dictSenses)
            .set({ definition: sense.definition })
            .where(and(eq(dictSenses.id, id), isNull(dictSenses.definition)));
        }
        senseIds.push(id);
      }

      // 4b — the lexeme's sense version. A recomputed count, not `+= n`: an
      // increment would double-count or drop one depending on interleaving,
      // where a count derived fresh from `dict_senses` cannot. Senses are only
      // ever added, never removed, so that count is monotonic and is a valid
      // version — PROVIDED it is computed after 1b's lock, not on its own.
      // This UPDATE's own row lock is not enough by itself: were a second
      // writer's blocked UPDATE to be what serialises them, unblocking would
      // re-fetch the ROW but not re-evaluate this subquery, which already ran
      // once, against the pre-block snapshot (see 1b). The lock 1b takes as a
      // separate, earlier statement is what makes the count below trustworthy.
      await tx
        .update(dictLexemes)
        .set({
          senseVersion: sql`(SELECT count(*) FROM ${dictSenses} WHERE ${dictSenses.lexemeId} = ${lexemeId})`,
        })
        .where(eq(dictLexemes.id, lexemeId));

      const [versioned] = await tx
        .select({ senseVersion: dictLexemes.senseVersion })
        .from(dictLexemes)
        .where(eq(dictLexemes.id, lexemeId));

      // 4c — Phase 31 (spec D6, D8). Every sense this form renders has a gloss in
      // this language before its rendering is written: kept, joined by key, or
      // new. Under 1b's lock, so two writers of one lexeme cannot both create a
      // gloss for one key.
      const { glossIds, needsMerge, counts } = await writeGlosses({
        lexemeId,
        userLanguageCode: input.userLanguageCode,
        lemmaForm: input.form.toLowerCase() === entry.lemma.toLowerCase(),
        senses: entry.senses.map((sense, i) => ({
          senseId: senseIds[i],
          translation: sense.translation,
          gloss: sense.gloss,
          glossAlternatives: sense.glossAlternatives,
          alternatives: sense.alternatives,
        })),
      });
      if (needsMerge) mergePairs.push({ lexemeId, userLanguageCode: input.userLanguageCode });
      glosses.created += counts.created;
      glosses.joined += counts.joined;
      glosses.members += counts.members;

      // 5 — this variant's own renderings. DO NOTHING because a form written
      // twice keeps the answer it already gave: phase 10's guarantee, now held
      // at the level that actually decides an answer.
      await tx
        .insert(dictVarTranslations)
        .values(
          entry.senses.map((sense, i) => ({
            variantId: variant.id,
            senseId: senseIds[i],
            userLanguageCode: input.userLanguageCode,
            // This form's own ordering, straight from the entry the model
            // returned for it — `entriesToRows` set it from the array position.
            rank: sense.rank,
            translation: sense.translation,
            gloss: sense.gloss,
            alternatives: sense.alternatives,
            exampleSource: sense.exampleSource,
            exampleTarget: sense.exampleTarget,
          })),
        )
        .onConflictDoNothing({
          // Named, never bare — for the same reason the variant insert above
          // names its target: a bare DO NOTHING would also swallow a collision
          // on UNIQUE(variant_id, user_language_code, rank), the safety net
          // that must be allowed to raise.
          target: [
            dictVarTranslations.variantId,
            dictVarTranslations.senseId,
            dictVarTranslations.userLanguageCode,
          ],
        });

      // 5b — this form is now rendered against that version, in this language. Read AFTER the
      // bump, never before: stamping the pre-bump value would leave the variant
      // permanently one behind and re-render it on every lookup forever.
      await tx
        .insert(dictVariantRenderings)
        .values({
          variantId: variant.id,
          userLanguageCode: input.userLanguageCode,
          renderedSenseVersion: versioned.senseVersion,
        })
        .onConflictDoUpdate({
          target: [dictVariantRenderings.variantId, dictVariantRenderings.userLanguageCode],
          set: { renderedSenseVersion: versioned.senseVersion },
        });

      written.push({
        lemma: entry.lemma,
        lexemeId,
        variantId: variant.id,
        senseIds,
        glossIds,
        created,
      });
    }

    // 6 — the re-read. Returning only what was just written would give the
    // writer a different answer from the next reader whenever the queried form
    // was already a variant of another lexeme. One query, and the invariant
    // becomes literal: the response is always the same merge the next lookup
    // would produce.
    const senses = rowsToCards(
      await findSensesByForm({
        form: input.form,
        languageCode: input.languageCode,
        userLanguageCode: input.userLanguageCode,
      }),
    );

    return { written, senses, mergePairs, glosses };
  };

  /**
   * One lexeme's current sense version.
   *
   * A primitive of its own rather than a column on `findSensesByLexeme`,
   * because the caller must read it in the SAME transaction as the sense list
   * it is about to render and BEFORE it — a repair stamps the version its
   * renderings were derived from, never the version the lexeme has reached by
   * the time the write lands, which may be minutes later. See
   * `repairVariantRenderings`.
   */
  const findSenseVersion = async (input: { lexemeId: string }): Promise<number> => {
    const [lexeme] = await tx
      .select({ senseVersion: dictLexemes.senseVersion })
      .from(dictLexemes)
      .where(eq(dictLexemes.id, input.lexemeId));
    return lexeme.senseVersion;
  };

  /**
   * Replace one variant's renderings for one target language, and mark it
   * rendered against the version those renderings were derived from.
   *
   * DELETE then INSERT rather than UPDATE, because the repair may return fewer
   * senses than are stored (the form declined one) as well as more, and because
   * re-ranking in place would collide with
   * UNIQUE(variant_id, user_language_code, rank) partway through — the
   * constraint is checked per statement, not at commit.
   *
   * **`senseVersion` is a parameter, not a read.** Stamping whatever the lexeme
   * holds at write time would be a lost update: the renderings below were
   * derived from a sense list read before a 5-15 second model call, and a
   * concurrent lookup that adds a sense during that call would leave this
   * variant stamped level against a version it never rendered — the new sense
   * invisible to this form forever, which is the exact defect this whole
   * mechanism exists to remove. Under-stamping is the safe direction: a variant
   * wrongly thought stale costs one repair, a variant wrongly thought level is
   * permanent.
   *
   * **A repair may not drop a sense this variant already renders.** The delete
   * below is unconditional, so a model call that returns `translation: null`
   * for a sense the form has been serving would erase that rendering with
   * nothing to restore it from — and if this variant were the only bearer of a
   * rendering for that sense, `findSensesByLexeme` (an INNER JOIN through
   * `dict_var_translations`) would stop returning the sense at all, so the next
   * form's reconciliation would never see it, would name the meaning afresh,
   * and would write a DUPLICATE sense: precisely what the reconciliation call
   * exists to prevent. The dictionary has no TTL, so that duplicate is forever
   * while a refused repair costs one retry — so this fails closed, exactly as
   * the reconciliation path does, and the caller serves the stored answer.
   */
  const repairVariantRenderings = async (input: {
    variantId: string;
    lexemeId: string;
    userLanguageCode: string;
    senseVersion: number;
    lemmaForm: boolean;
    senses: RepairedRendering[];
  }): Promise<{ needsMerge: boolean }> => {
    const current = await tx
      .select({ senseId: dictVarTranslations.senseId })
      .from(dictVarTranslations)
      .where(
        and(
          eq(dictVarTranslations.variantId, input.variantId),
          eq(dictVarTranslations.userLanguageCode, input.userLanguageCode),
        ),
      );

    const keeping = new Set(input.senses.map((sense) => sense.senseId));
    const dropped = current.filter((row) => !keeping.has(row.senseId)).map((row) => row.senseId);
    if (dropped.length > 0) throw new RepairWouldDropSense(input.variantId, dropped);

    // Phase 31 (spec D6, D8). The repair is the second writer of renderings: a
    // sense it renders in this language for the first time gets its gloss here,
    // and a repair of the lemma form may rename. The caller holds lockLexemes.
    const { needsMerge } = await writeGlosses({
      lexemeId: input.lexemeId,
      userLanguageCode: input.userLanguageCode,
      lemmaForm: input.lemmaForm,
      senses: input.senses.map((sense) => ({
        senseId: sense.senseId,
        translation: sense.translation,
        gloss: sense.gloss,
        glossAlternatives: sense.glossAlternatives,
        alternatives: sense.alternatives,
      })),
    });

    // Phase 31 (spec D9). The rendering call names definitions too.
    for (const sense of input.senses) {
      if (sense.definition === null) continue;
      await tx
        .update(dictSenses)
        .set({ definition: sense.definition })
        .where(and(eq(dictSenses.id, sense.senseId), isNull(dictSenses.definition)));
    }

    await tx
      .delete(dictVarTranslations)
      .where(
        and(
          eq(dictVarTranslations.variantId, input.variantId),
          eq(dictVarTranslations.userLanguageCode, input.userLanguageCode),
        ),
      );

    await tx.insert(dictVarTranslations).values(
      input.senses.map((sense) => ({
        variantId: input.variantId,
        senseId: sense.senseId,
        userLanguageCode: input.userLanguageCode,
        rank: sense.rank,
        translation: sense.translation,
        gloss: sense.gloss,
        alternatives: sense.alternatives,
        exampleSource: sense.exampleSource,
        exampleTarget: sense.exampleTarget,
      })),
    );

    await tx
      .insert(dictVariantRenderings)
      .values({
        variantId: input.variantId,
        userLanguageCode: input.userLanguageCode,
        renderedSenseVersion: input.senseVersion,
      })
      .onConflictDoUpdate({
        target: [dictVariantRenderings.variantId, dictVariantRenderings.userLanguageCode],
        set: { renderedSenseVersion: input.senseVersion },
      });

    return { needsMerge };
  };

  /** Phase 31. One lexeme, for the render-lemma job. */
  const findLexeme = async (
    lexemeId: string,
  ): Promise<{ id: string; lemma: string; languageCode: string; partOfSpeech: string } | undefined> => {
    const [row] = await tx
      .select({ id: dictLexemes.id, lemma: dictLexemes.lemma, languageCode: dictLexemes.languageCode, partOfSpeech: dictLexemes.partOfSpeech })
      .from(dictLexemes)
      .where(eq(dictLexemes.id, lexemeId));
    return row;
  };

  /** Phase 31 (spec D12). Whether a lexeme's lemma form renders it in a language:
   *  the condition the read and both claims below share. */
  const LEMMA_RENDERED = (lexeme: SQL, language: SQL) => sql`
    EXISTS (
      SELECT 1 FROM dict_variants v
      JOIN dict_lexemes l           ON l.id = v.lexeme_id
      JOIN dict_var_translations tr ON tr.variant_id = v.id AND tr.user_language_code = ${language}
      WHERE v.lexeme_id = ${lexeme} AND lower(v.form) = lower(l.lemma))`;

  /** Phase 31 (spec D12). Whether this lexeme's lemma form renders it in a language. */
  const hasLemmaRendering = async (input: LexemeLanguage): Promise<boolean> => {
    const rows = await tx.execute<{ rendered: boolean }>(
      sql`SELECT ${LEMMA_RENDERED(sql`${input.lexemeId}`, sql`${input.userLanguageCode}`)} AS rendered`,
    );
    return rows.rows[0].rendered;
  };

  /** Phase 31 (spec D12). The next free entry rank of a form, for a headword added
   *  to a form already written: the safety net
   *  dict_variants_form_entry_rank_key stays a safety net. */
  const nextEntryRank = async (input: { form: string; languageCode: string }): Promise<number> => {
    const rows = await tx.execute<{ next: number }>(sql`
      SELECT coalesce(max(entry_rank) + 1, 0)::int AS next FROM dict_variants
      WHERE language_code = ${input.languageCode} AND lower(form) = lower(${input.form})`);
    return rows.rows[0].next;
  };

  /** Phase 31 (plan item 3). Records a render request for each pair whose lemma
   *  form is unrendered and that was never requested, and returns those: the
   *  ones to enqueue.
   *
   *  Both claims insert in key order, (lexeme_id, user_language_code), for
   *  lockLexemes' reason: an insert waits on another transaction's uncommitted
   *  row with the same key, so two saves that share two unrendered lexemes and
   *  inserted them in opposite orders would each hold one key the other waits
   *  for, a deadlock. In one order, the second waits for the first and then
   *  finds the rows there. */
  const claimLemmaRenders = async (pairs: LexemeLanguage[]): Promise<LexemeLanguage[]> => {
    if (pairs.length === 0) return [];
    const rows = await tx.execute<{ lexeme_id: string; user_language_code: string }>(sql`
      INSERT INTO dict_lemma_renders (lexeme_id, user_language_code)
      SELECT DISTINCT asked.lexeme_id, asked.user_language_code
      FROM (VALUES ${sql.join(pairs.map((p) => sql`(${p.lexemeId}::text, ${p.userLanguageCode}::text)`), sql`, `)})
           AS asked(lexeme_id, user_language_code)
      WHERE NOT ${LEMMA_RENDERED(sql`asked.lexeme_id`, sql`asked.user_language_code`)}
      ORDER BY asked.lexeme_id, asked.user_language_code
      ON CONFLICT DO NOTHING
      RETURNING lexeme_id, user_language_code`);
    return rows.rows.map((row) => ({ lexemeId: row.lexeme_id, userLanguageCode: row.user_language_code }));
  };

  /** The same for every saved gloss of every enrollment: the start-up backfill.
   *  In key order, as claimLemmaRenders explains. */
  const claimSavedLemmaRenders = async (): Promise<LexemeLanguage[]> => {
    const rows = await tx.execute<{ lexeme_id: string; user_language_code: string }>(sql`
      INSERT INTO dict_lemma_renders (lexeme_id, user_language_code)
      SELECT DISTINCT ve.lexeme_id, e.source_language
      FROM vocabulary_entries ve
      JOIN enrollments e ON e.id = ve.enrollment_id
      WHERE NOT ${LEMMA_RENDERED(sql`ve.lexeme_id`, sql`e.source_language`)}
      ORDER BY ve.lexeme_id, e.source_language
      ON CONFLICT DO NOTHING
      RETURNING lexeme_id, user_language_code`);
    return rows.rows.map((row) => ({ lexemeId: row.lexeme_id, userLanguageCode: row.user_language_code }));
  };

  /** Phase 31 (spec D12). The render-lemma dead letter's write: gives back the
   *  claim of a render whose retries are spent, so the next save or start asks
   *  again. Whether there was a claim to give back. */
  const releaseLemmaRender = async (input: LexemeLanguage): Promise<boolean> => {
    const released = await tx
      .delete(dictLemmaRenders)
      .where(and(eq(dictLemmaRenders.lexemeId, input.lexemeId), eq(dictLemmaRenders.userLanguageCode, input.userLanguageCode)))
      .returning({ lexemeId: dictLemmaRenders.lexemeId });
    return released.length > 0;
  };

  /** Phase 31 (spec D12). Every rendering of every member of these glosses in one
   *  learner language, with its form and its own citation form. */
  const findGlossRenderings = async (input: { glossIds: string[]; userLanguageCode: string }): Promise<GlossRendering[]> => {
    if (input.glossIds.length === 0) return [];
    const rows = await tx.execute<{ gloss_id: string; sense_id: string; variant_id: string; form: string; gloss: string; rank: number }>(sql`
      SELECT m.gloss_id, tr.sense_id, tr.variant_id, v.form, tr.gloss, tr.rank
      FROM dict_sense_glosses m
      JOIN dict_var_translations tr ON tr.sense_id = m.sense_id AND tr.user_language_code = m.user_language_code
      JOIN dict_variants v          ON v.id = tr.variant_id
      WHERE m.gloss_id IN (${sql.join(input.glossIds.map((id) => sql`${id}`), sql`, `)})
        AND m.user_language_code = ${input.userLanguageCode}`);
    return rows.rows.map((row) => ({
      glossId: row.gloss_id,
      senseId: row.sense_id,
      variantId: row.variant_id,
      form: row.form,
      gloss: row.gloss,
      rank: row.rank,
    }));
  };

  /** Phase 31 (spec D18). For each of these glosses, the lemmas of the other
   *  headwords of its language pair whose live gloss has the same key: `order`
   *  beside `book` under להזמין. Through dict_glosses_language_key_idx. */
  const findSiblings = async (input: { glossIds: string[] }): Promise<{ glossId: string; lemma: string }[]> => {
    if (input.glossIds.length === 0) return [];
    const rows = await tx.execute<{ gloss_id: string; lemma: string }>(sql`
      SELECT DISTINCT p.id AS gloss_id, l2.lemma
      FROM dict_glosses p
      JOIN dict_lexemes l1 ON l1.id = p.lexeme_id
      JOIN dict_glosses s  ON s.user_language_code = p.user_language_code
                          AND gloss_key(s.key) = gloss_key(p.key)
                          AND s.lexeme_id <> p.lexeme_id
                          AND s.merged_into IS NULL
      JOIN dict_lexemes l2 ON l2.id = s.lexeme_id AND l2.language_code = l1.language_code
      WHERE p.id IN (${sql.join(input.glossIds.map((id) => sql`${id}`), sql`, `)})
      ORDER BY 1, 2`);
    return rows.rows.map((row) => ({ glossId: row.gloss_id, lemma: row.lemma }));
  };

  return {
    claimLemmaRenders,
    claimSavedLemmaRenders,
    findCorrectionByForm,
    findGlossRenderings,
    findLexeme,
    findSenseVersion,
    findSensesByForm,
    findSensesByLexeme,
    findSiblings,
    findStaleLexemesByForm,
    hasLemmaRendering,
    lockLexemes,
    nextEntryRank,
    persistCorrection,
    persistEntries,
    releaseLemmaRender,
    repairVariantRenderings,
  };
}

export type DictRepo = ReturnType<typeof createDictRepo>;
