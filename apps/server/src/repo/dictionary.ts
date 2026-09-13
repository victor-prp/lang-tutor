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
   * One write, ending in a re-read.
   *
   * **First-writer-wins splits in two in phase 12.** A sense is written once per
   * lexeme — that is step 4, and it is why two lookups of one headword do not
   * accumulate near-duplicate meanings. A *translation* is written once per
   * (variant, sense): step 5. So a second form of a headword the dictionary
   * already knows adds no senses but does add its own renderings of them, which
   * is the whole of the rendering fix. Neither is ever rewritten, merged or
   * refreshed — there is no TTL and no invalidation, which is what makes the
   * concurrent case trivial and is also why a poor answer is served from then on.
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

    for (const entry of entriesToRows(input.entries)) {
      // 1 — the lexeme, which is the PAIR of a lemma and a part of speech from
      // phase 12 on. DO NOTHING returns no row, which is exactly how "it was
      // already there" is detected; a concurrent request for the same new
      // lexeme blocks here until the first commits.
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

      written.push({
        lemma: entry.lemma,
        lexemeId,
        variantId: variant.id,
        senseIds,
        created: !!inserted,
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

  return { findSensesByForm, persistEntries };
}

export type DictRepo = ReturnType<typeof createDictRepo>;
