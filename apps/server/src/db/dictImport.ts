import type { Db } from './client';
import { createTransaction } from './transaction';
import type { CorrectionRecord, DictRecord } from './dictExport';
import { createDictRepo } from '../repo/dictionary';

export type ImportResult = {
  /** Records replayed. */
  records: number;
  /** Entries whose LEXEME row this run actually inserted. One headword can be
   *  two of them — `book` is a noun and a verb — so this is not a count of
   *  headwords. */
  lexemesCreated: number;
};

/**
 * Replays exported records through `persistEntries` — the same repository
 * function a live lookup and `db/seed.ts` call — so a restored row is
 * indistinguishable from one a learner's lookup wrote.
 *
 * **Safe against a database that already has data**, which is the whole point
 * for production: `persistEntries` is ON CONFLICT DO NOTHING at every level —
 * lexemes, variants, senses and, since phase 12, each variant's own
 * translations — so a form already looked up keeps both the senses it has and
 * the wording it answers with. Restoring is therefore idempotent and never
 * overwrites live content.
 *
 * Chunked rather than one transaction for the whole file: the full backfill is
 * ~89k records, and a single transaction holding that many inserts would keep
 * one connection and its locks busy for minutes and pile the lot into one WAL
 * commit. A chunk that fails rolls back only itself — and because the replay is
 * idempotent, the fix is to re-run the same file.
 *
 * `onProgress` is a required parameter, not an optional one with a default:
 * ADR 0001 R7 forbids `console` outside `db/cli.ts`, so the caller supplies
 * reporting, and ADR 0002 R5 forbids defaulting a collaborator.
 */
export async function importDictionary(
  db: Db,
  input: {
    records: DictRecord[];
    languageCode: string;
    userLanguageCode: string;
    chunkSize: number;
    onProgress: (done: number, total: number) => void;
  },
): Promise<ImportResult> {
  const inTransaction = createTransaction(db, (tx) => tx);
  const total = input.records.length;
  let lexemesCreated = 0;

  for (let start = 0; start < total; start += input.chunkSize) {
    const chunk = input.records.slice(start, start + input.chunkSize);

    await inTransaction(async (tx) => {
      const dict = createDictRepo(tx);
      for (const record of chunk) {
        const { written } = await dict.persistEntries({
          form: record.form,
          languageCode: input.languageCode,
          userLanguageCode: input.userLanguageCode,
          kind: record.kind,
          entries: record.entries,
        });
        lexemesCreated += written.filter((entry) => entry.created).length;
      }
    });

    input.onProgress(Math.min(start + input.chunkSize, total), total);
  }

  return { records: total, lexemesCreated };
}

/**
 * Replays exported redirects through `persistCorrection` — the same repository
 * function a live lookup calls — so a restored row and a looked-up one are
 * indistinguishable, the guarantee `importDictionary` already provides for the
 * dictionary.
 *
 * **Not chunked**, unlike `importDictionary`. That one is chunked because the
 * backfill is ~89k records; this file arrives empty and stays near-empty, since
 * the backfill word list is correctly spelled and corrections accumulate only
 * from real learners. One transaction is the simpler shape while that is true.
 *
 * Safe against a database that already holds part of the file:
 * `persistCorrection` is ON CONFLICT DO NOTHING, so a redirect already written
 * keeps the target it has.
 */
export async function importCorrections(
  db: Db,
  input: { records: CorrectionRecord[]; languageCode: string },
): Promise<{ records: number }> {
  if (input.records.length === 0) return { records: 0 };

  const inTransaction = createTransaction(db, (tx) => tx);
  await inTransaction(async (tx) => {
    const dict = createDictRepo(tx);
    for (const record of input.records) {
      await dict.persistCorrection({
        languageCode: input.languageCode,
        typedForm: record.typed_form,
        correctedForm: record.corrected_form,
        alternatives: record.alternatives,
      });
    }
  });

  return { records: input.records.length };
}
