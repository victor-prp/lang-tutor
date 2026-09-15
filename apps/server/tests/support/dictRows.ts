import type { Db } from '../../src/db/client';
import { dictLexemes, dictSenses, dictVarTranslations, dictVariants } from '../../src/db/schema';

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
