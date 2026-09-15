import type { LlmEntry, TranslationKind, TranslationSense } from '@lang-tutor/core/api';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { RepairWouldDropSense } from '../errors';
import {
  dictVarTranslations,
  dictVariants,
  dictLexemes,
  dictSenses,
} from '../db/schema';
import {
  entriesToRows,
  rowsToSenses,
  staleLexemes,
  type EntryRows,
  type SenseRow,
  type StaleLexeme,
} from '../domain/dictionary';

// The response cap. The database has no five limit — `see` keeps all its
// senses and `saw` all of its — so this truncates the merge and nothing else,
// which is why a later lookup of `see` returns its full entry rather than
// whatever slice fitted alongside `saw`.
const READ_LIMIT = 5;

export type PersistEntriesInput = {
  /** The queried string, already normalized. Stored as written; matched lower. */
  form: string;
  languageCode: string;
  userLanguageCode: string;
  kind: TranslationKind;
  entries: LlmEntry[];
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
  created: boolean;
};

/** One rendering a repair produces. Exported beside `PersistedEntry`. */
export type RepairedRendering = {
  senseId: string;
  rank: number;
  translation: string;
  exampleSource: string | null;
  exampleTarget: string | null;
};

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
   */
  const findSensesByForm = async (input: {
    form: string;
    languageCode: string;
    userLanguageCode: string;
  }): Promise<SenseRow[]> =>
    tx
      .select({
        lexemeId: dictVariants.lexemeId,
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
      )
      .limit(READ_LIMIT);

  /**
   * One row per lexeme this form belongs to, carrying both versions. No limit
   * and no join to the translations: staleness is a property of the variant,
   * not of the rows that happen to fit in an answer.
   */
  const findStaleLexemesByForm = async (input: {
    form: string;
    languageCode: string;
  }): Promise<StaleLexeme[]> =>
    staleLexemes(
      await tx
        .select({
          lexemeId: dictVariants.lexemeId,
          variantId: dictVariants.id,
          lemma: dictLexemes.lemma,
          partOfSpeech: dictLexemes.partOfSpeech,
          senseVersion: dictLexemes.senseVersion,
          renderedSenseVersion: dictVariants.renderedSenseVersion,
        })
        .from(dictVariants)
        .innerJoin(dictLexemes, eq(dictLexemes.id, dictVariants.lexemeId))
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
   */
  const findSensesByLexeme = async (input: {
    lemma: string;
    partOfSpeech: string;
    languageCode: string;
    userLanguageCode: string;
  }): Promise<
    { senseId: string; senseCode: string; translation: string; exampleSource: string | null;
      exampleTarget: string | null }[]
  > => {
    // Drizzle has no first-class DISTINCT ON, so this is written as `sql`. The
    // shape is the invariant, not the spelling: one row per sense, chosen
    // deterministically, over ALL variants of the lexeme.
    const rows = await tx.execute<{
      sense_id: string;
      sense_code: string;
      translation: string;
      example_source: string | null;
      example_target: string | null;
    }>(sql`
      SELECT sense_id, sense_code, translation, example_source, example_target
      FROM (
        SELECT DISTINCT ON (s.id)
               s.id          AS sense_id,
               s.sense_code  AS sense_code,
               tr.translation,
               tr.example_source,
               tr.example_target,
               tr.rank       AS rank
        FROM dict_lexemes l
        JOIN dict_senses s            ON s.lexeme_id = l.id
        JOIN dict_var_translations tr ON tr.sense_id = s.id
                                     AND tr.user_language_code = ${input.userLanguageCode}
        JOIN dict_variants v          ON v.id = tr.variant_id
        WHERE l.language_code = ${input.languageCode}
          AND l.lemma = ${input.lemma}
          AND l.part_of_speech = ${input.partOfSpeech}
        ORDER BY s.id, tr.rank, v.id
      ) picked
      ORDER BY rank, sense_code
    `);

    return rows.rows.map((row) => ({
      senseId: row.sense_id,
      senseCode: row.sense_code,
      translation: row.translation,
      exampleSource: row.example_source,
      exampleTarget: row.example_target,
    }));
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
  ): Promise<{ written: PersistedEntry[]; senses: TranslationSense[] }> => {
    const written: PersistedEntry[] = [];
    const rows = entriesToRows(input.entries);

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
    if (resolved.length > 0) {
      await tx
        .select({ id: dictLexemes.id })
        .from(dictLexemes)
        .where(
          inArray(
            dictLexemes.id,
            resolved.map((row) => row.lexemeId),
          ),
        )
        .orderBy(asc(dictLexemes.id))
        .for('update');
    }

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
            .values({ lexemeId, senseCode: sense.senseCode })
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

      // 5b — this form is now rendered against that version. Read AFTER the
      // bump, never before: stamping the pre-bump value would leave the variant
      // permanently one behind and re-render it on every lookup forever.
      await tx
        .update(dictVariants)
        .set({ renderedSenseVersion: versioned.senseVersion })
        .where(eq(dictVariants.id, variant.id));

      written.push({
        lemma: entry.lemma,
        lexemeId,
        variantId: variant.id,
        senseIds,
        created,
      });
    }

    // 6 — the re-read. Returning only what was just written would give the
    // writer a different answer from the next reader whenever the queried form
    // was already a variant of another lexeme. One query, and the invariant
    // becomes literal: the response is always the same merge the next lookup
    // would produce.
    const senses = rowsToSenses(
      await findSensesByForm({
        form: input.form,
        languageCode: input.languageCode,
        userLanguageCode: input.userLanguageCode,
      }),
    );

    return { written, senses };
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
    userLanguageCode: string;
    senseVersion: number;
    senses: RepairedRendering[];
  }): Promise<void> => {
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
        exampleSource: sense.exampleSource,
        exampleTarget: sense.exampleTarget,
      })),
    );

    await tx
      .update(dictVariants)
      .set({ renderedSenseVersion: input.senseVersion })
      .where(eq(dictVariants.id, input.variantId));
  };

  return {
    findSenseVersion,
    findSensesByForm,
    findSensesByLexeme,
    findStaleLexemesByForm,
    persistEntries,
    repairVariantRenderings,
  };
}

export type DictRepo = ReturnType<typeof createDictRepo>;
