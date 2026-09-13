import type { LlmEntry, TranslationKind, TranslationSense } from '@lang-tutor/core/api';
import { and, asc, eq, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import {
  dictVarTranslations,
  dictVariants,
  dictLexemes,
  dictSenses,
} from '../db/schema';
import { entriesToRows, rowsToSenses, type SenseRow } from '../domain/dictionary';

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

/** What one entry became. `senseIds` is the term's senses in rank order —
 *  whether this call wrote them or found them already there. */
export type PersistedEntry = {
  lemma: string;
  lexemeId: string;
  variantId: string;
  senseIds: string[];
  created: boolean;
};

export function createDictRepo(tx: Tx) {
  /**
   * Three tables, driven by the unique index's (language_code, lower(form))
   * prefix, with no join to `dict_lexemes` at all — language and the ordering
   * key both live on the variant now.
   *
   * The inner join to `dict_var_translations` *is* the servability test: a
   * term with no translation in the language being asked for returns zero rows,
   * which the service reads as a miss. No column and no flag.
   *
   * `(s.rank, v.entry_rank)` is unique across one form's rows and `v.lexeme_id`
   * closes it, so identical requests return identical answers — forever.
   */
  const findSensesByForm = async (input: {
    form: string;
    languageCode: string;
    userLanguageCode: string;
  }): Promise<SenseRow[]> =>
    tx
      .select({
        lexemeId: dictVariants.lexemeId,
        rank: dictSenses.rank,
        entryRank: dictVariants.entryRank,
        partOfSpeech: dictSenses.partOfSpeech,
        exampleSource: dictSenses.exampleSource,
        translation: dictVarTranslations.translation,
        exampleTarget: dictVarTranslations.exampleTarget,
        // `dict_variants.kind` is `text`, not a typed enum column, so it comes
        // back untyped from Drizzle; cast rather than widen `SenseRow.kind`,
        // since the write (below) already only ever stores a `TranslationKind`.
        kind: sql<TranslationKind>`${dictVariants.kind}`,
      })
      .from(dictVariants)
      .innerJoin(dictSenses, eq(dictSenses.lexemeId, dictVariants.lexemeId))
      .innerJoin(
        dictVarTranslations,
        and(
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
      // Rank leads, so the merge across headwords is round-robin rather than
      // block-per-entry: ordering by entry first would put all of `see`'s
      // senses ahead of `saw`'s, and a five-sense `see` would push `מסור` off
      // the cap entirely.
      .orderBy(asc(dictSenses.rank), asc(dictVariants.entryRank), asc(dictVariants.lexemeId))
      .limit(READ_LIMIT);

  /**
   * One write, first-writer-wins per term, ending in a re-read.
   *
   * Step 4 is the one condition that covers the cases that looked separate: a
   * brand-new headword writes its senses, and an entry naming a headword that
   * already exists contributes only its variant. A term that has senses is
   * never rewritten, merged or refreshed — there is no TTL and no
   * invalidation, which is what makes the concurrent case trivial and is also
   * why a poor answer for a new headword is served to everyone from then on.
   *
   * The concurrent double-miss is handled at step 1 rather than by retry logic:
   * the second transaction blocks on UNIQUE(language_code, lemma) until the
   * first commits, then finds the senses already there.
   */
  const persistEntries = async (
    input: PersistEntriesInput,
  ): Promise<{ written: PersistedEntry[]; senses: TranslationSense[] }> => {
    const written: PersistedEntry[] = [];

    for (const entry of entriesToRows(input.entries)) {
      // 1 — the term. DO NOTHING returns no row, which is exactly how "it was
      // already there" is detected; a concurrent request for the same new
      // lemma blocks here until the first commits.
      const [inserted] = await tx
        .insert(dictLexemes)
        .values({ languageCode: input.languageCode, lemma: entry.lemma })
        .onConflictDoNothing({ target: [dictLexemes.languageCode, dictLexemes.lemma] })
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
            ),
          );
        lexemeId = existing.id;
      }

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

      // 3 — this term's senses, in rank order. The seed hangs its questions
      // off senseIds[0], so the order is part of the contract.
      const existingSenses = await tx
        .select({ id: dictSenses.id })
        .from(dictSenses)
        .where(eq(dictSenses.lexemeId, lexemeId))
        .orderBy(asc(dictSenses.rank));

      let senseIds = existingSenses.map((sense) => sense.id);

      // 4 — first writer wins.
      if (senseIds.length === 0) {
        const rows = await tx
          .insert(dictSenses)
          .values(
            entry.senses.map((sense) => ({
              lexemeId,
              senseCode: sense.senseCode,
              rank: sense.rank,
              partOfSpeech: sense.partOfSpeech,
              exampleSource: sense.exampleSource,
            })),
          )
          .returning({ id: dictSenses.id, rank: dictSenses.rank });

        const idByRank = new Map(rows.map((row) => [row.rank, row.id]));
        senseIds = entry.senses.map((sense) => idByRank.get(sense.rank)!);

        await tx.insert(dictVarTranslations).values(
          entry.senses.map((sense) => ({
            senseId: idByRank.get(sense.rank)!,
            userLanguageCode: input.userLanguageCode,
            translation: sense.translation,
            exampleTarget: sense.exampleTarget,
          })),
        );
      }

      written.push({ lemma: entry.lemma, lexemeId, variantId: variant.id, senseIds, created: !!inserted });
    }

    // 5 — the re-read. Returning only what was just written would give the
    // writer a different answer from the next reader whenever the queried form
    // was already a variant of another term. One query, and the invariant
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

  return { findSensesByForm, persistEntries };
}

export type DictRepo = ReturnType<typeof createDictRepo>;
