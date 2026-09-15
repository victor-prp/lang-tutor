import { eq } from 'drizzle-orm';

import type { Db } from '../../src/db/client';
import {
  dictCorrections,
  dictLexemes,
  dictSenses,
  dictVarTranslations,
  dictVariants,
} from '../../src/db/schema';
import { createDictRepo } from '../../src/repo/dictionary';
import { withTx } from './withTx';

/**
 * Writes one lexeme's rows directly, without going through persistEntries.
 *
 * That is the point: the ordering rules this phase rests on must be provable
 * against rows a test chose, not against rows a model produced. tests/support/
 * is the test composition root, so reaching into db/schema.ts here is exactly
 * the carve-out ADR 0001 grants it.
 *
 * Every field is required. A defaulted language code is how a test ends up
 * asserting against a pair it never named.
 */

/** A sense is pure identity from phase 12 on. Its position in `senses` is not a
 *  rank — a sense has no order of its own, only a position inside some given
 *  form's answer, which is what `SeedVariant.translations` carries. */
export type SeedSense = { senseCode: string };

/** One rendering of one sense for one form. `senseCode` picks which sense;
 *  `rank` is where THIS form puts it. */
export type SeedTranslation = {
  senseCode: string;
  rank: number;
  translation: string;
  exampleSource: string | null;
  exampleTarget: string | null;
};

export type SeedVariant = {
  form: string;
  kind: string;
  entryRank: number;
  translations: SeedTranslation[];
};

/**
 * Note what this shape makes expressible and the pre-phase-12 one did not: two
 * variants of one lexeme can carry different renderings of the same senses, and
 * can rank them differently. That is the whole of the rendering defect, stated
 * as a data shape.
 */
export type SeedLexeme = {
  lemma: string;
  languageCode: string;
  partOfSpeech: string;
  userLanguageCode: string;
  senses: SeedSense[];
  variants: SeedVariant[];
};

export async function insertLexeme(
  db: Db,
  spec: SeedLexeme,
): Promise<{ lexemeId: string; variantIds: string[]; senseIds: string[] }> {
  const [lexeme] = await db
    .insert(dictLexemes)
    .values({
      languageCode: spec.languageCode,
      lemma: spec.lemma,
      partOfSpeech: spec.partOfSpeech,
    })
    .returning({ id: dictLexemes.id });

  const senseIds: string[] = [];
  const idByCode = new Map<string, string>();
  for (const sense of spec.senses) {
    const [row] = await db
      .insert(dictSenses)
      .values({ lexemeId: lexeme.id, senseCode: sense.senseCode })
      .returning({ id: dictSenses.id });
    idByCode.set(sense.senseCode, row.id);
    senseIds.push(row.id);
  }

  const variantIds: string[] = [];
  for (const variant of spec.variants) {
    const [row] = await db
      .insert(dictVariants)
      .values({
        lexemeId: lexeme.id,
        languageCode: spec.languageCode,
        form: variant.form,
        kind: variant.kind,
        entryRank: variant.entryRank,
      })
      .returning({ id: dictVariants.id });
    variantIds.push(row.id);

    if (variant.translations.length > 0) {
      await db.insert(dictVarTranslations).values(
        variant.translations.map((translation) => ({
          variantId: row.id,
          // Not `?? ''`: a translation naming a sense the lexeme does not have
          // is a broken fixture, and should fail here rather than insert a row
          // with an empty foreign key and fail somewhere less obvious.
          senseId: idByCode.get(translation.senseCode)!,
          userLanguageCode: spec.userLanguageCode,
          rank: translation.rank,
          translation: translation.translation,
          exampleSource: translation.exampleSource,
          exampleTarget: translation.exampleTarget,
        })),
      );
    }
  }

  return { lexemeId: lexeme.id, variantIds, senseIds };
}

// Phase 13. Small read/write helpers for the service-level correction suite
// (tests/integration/services/translations.correction.test.ts), which must
// stay black-box at the DATABASE too — ADR 0001 R2 forbids a service-layer
// test from importing drizzle-orm, src/db/ or src/repo/ directly, the same
// rule that keeps services/translations.ts itself off a database handle.
// tests/support/ is the test composition root and is exempt, so these live
// here beside `insertLexeme` rather than in the test file that calls them.

/** All `dict_corrections` rows, or how many of them exist. Callers that only
 *  need a count still get one array read — this table is tiny in every test. */
export async function readDictCorrections(
  db: Db,
): Promise<{ typedForm: string; correctedForm: string }[]> {
  return db
    .select({
      typedForm: dictCorrections.typedForm,
      correctedForm: dictCorrections.correctedForm,
    })
    .from(dictCorrections);
}

/** How many `dict_variants` rows exist for one form, or in total when `form`
 *  is omitted — the "before/after, nothing new was written" shape several
 *  correction tests need. */
export async function countDictVariants(db: Db, form?: string): Promise<number> {
  const rows = form === undefined
    ? await db.select().from(dictVariants)
    : await db.select().from(dictVariants).where(eq(dictVariants.form, form));
  return rows.length;
}

export async function countDictSenses(db: Db): Promise<number> {
  return (await db.select().from(dictSenses)).length;
}

export async function countDictVarTranslations(db: Db): Promise<number> {
  return (await db.select().from(dictVarTranslations)).length;
}

/** Deletes one lexeme and, by CASCADE, its variants, senses and translations —
 *  the dangling-redirect scenario, where a `dict_corrections` row survives a
 *  target that no longer has any rows because nothing references it. */
export async function deleteLexemeByLemma(db: Db, lemma: string): Promise<void> {
  await db.delete(dictLexemes).where(eq(dictLexemes.lemma, lemma));
}

/** Writes a redirect row directly through the repository, bypassing
 *  `translate` — for a test that stages a pre-existing redirect (the hop
 *  case) rather than one the service itself would have written. */
export async function insertCorrection(
  db: Db,
  input: { languageCode: string; typedForm: string; correctedForm: string; alternatives: string[] },
): Promise<void> {
  await withTx(db, (tx) => createDictRepo(tx).persistCorrection(input));
}
