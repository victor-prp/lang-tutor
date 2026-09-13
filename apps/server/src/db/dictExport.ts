import type { LlmEntry, LlmSense, TranslationKind } from '@lang-tutor/core/api';
import { and, asc, eq } from 'drizzle-orm';

import type { Db } from './client';
import {
  dictVarTranslations,
  dictVariants,
  dictLexemes,
  dictSenses,
} from './schema';

/**
 * One exported line is one *lookup*, not one term: `{ form, kind, entries }` is
 * exactly `persistEntries`' input minus the two language codes, so
 * `db/dictImport.ts` can replay it through the same repository function a live
 * lookup calls. That is what makes a restored row and a looked-up row
 * indistinguishable, the same guarantee `db/seed.ts` already relies on.
 *
 * The form is the unit for a second reason: one lookup of `saw` writes entries
 * for both `see` and `saw`, and that pairing lives on the variant
 * (`dict_variants.entry_rank`), not on the term. Exporting per term would lose
 * it; grouping variants by form and ordering by `entry_rank` restores it
 * exactly, because `entriesToRows` assigned those ranks from the array
 * positions this rebuilds.
 */
export type DictRecord = {
  form: string;
  kind: TranslationKind;
  entries: LlmEntry[];
};

type FlatRow = {
  form: string;
  kind: TranslationKind;
  entryRank: number;
  lemma: string;
  rank: number;
  senseCode: string;
  partOfSpeech: string | null;
  exampleSource: string | null;
  translation: string;
  exampleTarget: string | null;
};

/**
 * Rows to records. The inverse of `domain/dictionary.ts`'s `entriesToRows`:
 * `entryRank` is the entry's index, `rank` the sense's, both contiguous from
 * zero, so position in the rebuilt arrays *is* the stored rank.
 *
 * `part_of_speech` and `example` are omitted rather than emitted as null, and
 * `example` only when both halves are present — matching how `entriesToRows`
 * wrote them (`sense.example?.source ?? null`), so a re-export of a restored
 * database is byte-identical to what it was restored from.
 */
function groupRows(rows: FlatRow[]): DictRecord[] {
  const byForm = new Map<string, { record: DictRecord; entries: Map<number, LlmEntry> }>();

  for (const row of rows) {
    let group = byForm.get(row.form);
    if (!group) {
      group = { record: { form: row.form, kind: row.kind, entries: [] }, entries: new Map() };
      byForm.set(row.form, group);
    }

    let entry = group.entries.get(row.entryRank);
    if (!entry) {
      entry = { lemma: row.lemma, senses: [] };
      group.entries.set(row.entryRank, entry);
    }

    const sense: LlmSense = { translation: row.translation, sense_code: row.senseCode };
    if (row.partOfSpeech) sense.part_of_speech = row.partOfSpeech;
    if (row.exampleSource && row.exampleTarget) {
      sense.example = { source: row.exampleSource, target: row.exampleTarget };
    }
    entry.senses[row.rank] = sense;
  }

  const records: DictRecord[] = [];
  for (const group of byForm.values()) {
    const ranks = [...group.entries.keys()].sort((a, b) => a - b);
    group.record.entries = ranks.map((rank) => group.entries.get(rank)!);
    records.push(group.record);
  }

  // Sorted in JS, by UTF-16 code unit, rather than by SQL `ORDER BY form`:
  // Postgres' text ordering depends on the database's collation, so the same
  // data could export in a different order on another machine and show up as a
  // whole-file diff. This comparator depends on nothing outside the strings.
  records.sort((a, b) => (a.form < b.form ? -1 : a.form > b.form ? 1 : 0));
  return records;
}

/**
 * Every servable form in one language pair, as replayable records.
 *
 * The inner join to `dict_var_translations` is the same servability test the
 * by-form read uses: a term with no translation in `userLanguageCode`
 * contributes nothing, so the export carries exactly what a lookup could hit.
 */
export async function exportDictionary(
  db: Db,
  input: { languageCode: string; userLanguageCode: string },
): Promise<DictRecord[]> {
  const rows = await db
    .select({
      form: dictVariants.form,
      kind: dictVariants.kind,
      entryRank: dictVariants.entryRank,
      lemma: dictLexemes.lemma,
      rank: dictSenses.rank,
      senseCode: dictSenses.senseCode,
      partOfSpeech: dictSenses.partOfSpeech,
      exampleSource: dictSenses.exampleSource,
      translation: dictVarTranslations.translation,
      exampleTarget: dictVarTranslations.exampleTarget,
    })
    .from(dictVariants)
    .innerJoin(dictLexemes, eq(dictLexemes.id, dictVariants.lexemeId))
    .innerJoin(dictSenses, eq(dictSenses.lexemeId, dictVariants.lexemeId))
    .innerJoin(
      dictVarTranslations,
      and(
        eq(dictVarTranslations.senseId, dictSenses.id),
        eq(dictVarTranslations.userLanguageCode, input.userLanguageCode),
      ),
    )
    .where(eq(dictVariants.languageCode, input.languageCode))
    .orderBy(asc(dictVariants.form), asc(dictVariants.entryRank), asc(dictSenses.rank));

  return groupRows(rows as FlatRow[]);
}

/** One JSON object per line, newline-terminated. Stable key order per record,
 *  so a re-export with no data change produces no diff. */
export function toJsonl(records: DictRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

export function fromJsonl(text: string): DictRecord[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  return trimmed.split('\n').map((line) => JSON.parse(line) as DictRecord);
}
