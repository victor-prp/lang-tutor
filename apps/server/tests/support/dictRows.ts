import { normaliseGloss } from '@lang-tutor/core/domain';
import { eq, sql } from 'drizzle-orm';

import type { Db } from '../../src/db/client';
import {
  dictCorrections,
  dictGlosses,
  dictLexemes,
  dictSenseGlosses,
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
  /** Phase 31. The citation form; the translation when omitted. */
  gloss?: string;
  /** Phase 31. The rendering's alternatives; none when omitted. */
  alternatives?: string[];
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
): Promise<{ lexemeId: string; variantIds: string[]; senseIds: string[]; glossIds: string[] }> {
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
          gloss: translation.gloss ?? translation.translation,
          alternatives: translation.alternatives ?? [],
          exampleSource: translation.exampleSource,
          exampleTarget: translation.exampleTarget,
        })),
      );
    }
  }

  // Phase 31 (spec D8). Every rendered sense has a gloss, by the migration's
  // rule: the lemma form's rendering names it, else the lowest-ranked one, and
  // senses with one normalised key share it.
  const chosen = new Map<string, { key: string; lemmaForm: boolean; rank: number }>();
  for (const variant of spec.variants) {
    const lemmaForm = variant.form.toLowerCase() === spec.lemma.toLowerCase();
    for (const translation of variant.translations) {
      const senseId = idByCode.get(translation.senseCode)!;
      const key = translation.gloss ?? translation.translation;
      const current = chosen.get(senseId);
      const better =
        !current || (lemmaForm && !current.lemmaForm) || (lemmaForm === current.lemmaForm && translation.rank < current.rank);
      if (better) chosen.set(senseId, { key, lemmaForm, rank: translation.rank });
    }
  }
  const glossByKey = new Map<string, string>();
  const glossBySense = new Map<string, string>();
  for (const [senseId, { key }] of chosen) {
    let glossId = glossByKey.get(normaliseGloss(key));
    if (glossId === undefined) {
      const [row] = await db
        .insert(dictGlosses)
        .values({ lexemeId: lexeme.id, userLanguageCode: spec.userLanguageCode, key })
        .returning({ id: dictGlosses.id });
      glossId = row.id;
      glossByKey.set(normaliseGloss(key), glossId);
    }
    await db.insert(dictSenseGlosses).values({ senseId, lexemeId: lexeme.id, userLanguageCode: spec.userLanguageCode, glossId });
    glossBySense.set(senseId, glossId);
  }

  return { lexemeId: lexeme.id, variantIds, senseIds, glossIds: senseIds.map((id) => glossBySense.get(id) ?? '') };
}

/** Phase 31. `finger` with two glosses of one word, the drift D6 could not
 *  rename: body_part keyed אצבעות from `fingers`, digit keyed אצבע from `finger`. */
export async function insertDriftedFinger(db: Db) {
  const word = await insertLexeme(db, {
    lemma: 'finger',
    languageCode: 'en',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'body_part' }, { senseCode: 'digit' }],
    variants: [
      { form: 'fingers', kind: 'word', entryRank: 0, translations: [{ senseCode: 'body_part', rank: 0, translation: 'אצבעות', exampleSource: null, exampleTarget: null }] },
      { form: 'finger', kind: 'word', entryRank: 0, translations: [{ senseCode: 'digit', rank: 0, translation: 'אצבע', exampleSource: null, exampleTarget: null }] },
    ],
  });
  return { ...word, other: word.glossIds[0], survivor: word.glossIds[1], fingers: word.variantIds[0], finger: word.variantIds[1] };
}

/** Phase 31. One rendering written past insertLexeme's gloss rule: a form
 *  rendered after its senses' memberships were decided, which is how drift
 *  arrives. */
export async function insertRendering(
  db: Db,
  row: { variantId: string; senseId: string; userLanguageCode: string; translation: string; gloss: string; rank: number },
): Promise<void> {
  await db.insert(dictVarTranslations).values(row);
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

/** Phase 31. One lemma's senses with their definitions, by code. For service
 *  tests, which may not reach the database themselves (ADR 0001 R2). */
export async function readSenseDefinitions(db: Db, lemma: string): Promise<{ senseCode: string; definition: string | null }[]> {
  const rows = await db.execute<{ sense_code: string; definition: string | null }>(sql`
    select s.sense_code, s.definition from dict_senses s join dict_lexemes l on l.id = s.lexeme_id
    where l.lemma = ${lemma} order by s.sense_code`);
  return rows.rows.map((row) => ({ senseCode: row.sense_code, definition: row.definition }));
}
