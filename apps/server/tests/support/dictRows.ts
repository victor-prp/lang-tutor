import type { Db } from '../../src/db/client';
import {
  dictVarTranslations,
  dictVariants,
  dictLexemes,
  dictSenses,
} from '../../src/db/schema';

/**
 * Writes one headword's rows directly, without going through persistEntries.
 *
 * That is the point: the ordering rules this phase rests on must be provable
 * against rows a test chose, not against rows a model produced. tests/support/
 * is the test composition root, so reaching into db/schema.ts here is exactly
 * the carve-out ADR 0001 grants it.
 *
 * Every field is required. A defaulted language code is how a test ends up
 * asserting against a pair it never named.
 */
export type SeedSense = {
  rank: number;
  senseCode: string;
  translation: string;
  partOfSpeech: string | null;
  exampleSource: string | null;
  exampleTarget: string | null;
};

export type SeedTerm = {
  lemma: string;
  languageCode: string;
  userLanguageCode: string;
  variants: { form: string; kind: string; entryRank: number }[];
  senses: SeedSense[];
};

export async function insertTerm(
  db: Db,
  spec: SeedTerm,
): Promise<{ lexemeId: string; variantIds: string[]; senseIds: string[] }> {
  const [term] = await db
    .insert(dictLexemes)
    .values({ languageCode: spec.languageCode, lemma: spec.lemma })
    .returning({ id: dictLexemes.id });

  const variants = await db
    .insert(dictVariants)
    .values(
      spec.variants.map((variant) => ({
        lexemeId: term.id,
        languageCode: spec.languageCode,
        form: variant.form,
        kind: variant.kind,
        entryRank: variant.entryRank,
      })),
    )
    .returning({ id: dictVariants.id });

  const senseIds: string[] = [];
  for (const sense of spec.senses) {
    const [row] = await db
      .insert(dictSenses)
      .values({
        lexemeId: term.id,
        senseCode: sense.senseCode,
        rank: sense.rank,
        partOfSpeech: sense.partOfSpeech,
        exampleSource: sense.exampleSource,
      })
      .returning({ id: dictSenses.id });
    await db.insert(dictVarTranslations).values({
      senseId: row.id,
      userLanguageCode: spec.userLanguageCode,
      translation: sense.translation,
      exampleTarget: sense.exampleTarget,
    });
    senseIds.push(row.id);
  }

  return { lexemeId: term.id, variantIds: variants.map((v) => v.id), senseIds };
}
