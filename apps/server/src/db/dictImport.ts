import type { Db } from './client';
import { createTransaction } from './transaction';
import type { DictRecord } from './dictExport';
import { createDictRepo } from '../repo/dictionary';

export type ImportResult = {
  /** Records replayed. */
  records: number;
  /** Entries whose headword row this run actually inserted. */
  termsCreated: number;
};

/**
 * Replays exported records through `persistEntries` — the same repository
 * function a live lookup and `db/seed.ts` call — so a restored row is
 * indistinguishable from one a learner's lookup wrote.
 *
 * **Safe against a database that already has data**, which is the whole point
 * for production: `persistEntries` is ON CONFLICT DO NOTHING on terms and
 * variants and first-writer-wins on senses, so a form already looked up keeps
 * the senses it has and a re-run writes nothing. Restoring is therefore
 * idempotent and never overwrites live content.
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
  let termsCreated = 0;

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
        termsCreated += written.filter((entry) => entry.created).length;
      }
    });

    input.onProgress(Math.min(start + input.chunkSize, total), total);
  }

  return { records: total, termsCreated };
}
