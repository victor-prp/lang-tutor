import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { loadConfig } from '../config';
import { createDb } from './client';
import { runMigrations } from './migrate';
import { reseedContent } from './reseed';
import { seedContent } from './seed';
import {
  correctionsFromJsonl,
  correctionsToJsonl,
  exportCorrections,
  exportDictionary,
  fromJsonl,
  toJsonl,
} from './dictExport';
import { importCorrections, importDictionary } from './dictImport';

// The dictionary is en->he; the checked-in dataset is scoped by that pair, the
// same way scripts/translation-backfills/en-he/ is.
const TARGET_LANGUAGE = 'en';
const USER_LANGUAGE = 'he';
const DEFAULT_DATASET = join(__dirname, '../../../../data/backfill/en-he/dictionary.jsonl');

// Small enough that a failure loses little work, large enough that per-chunk
// transaction overhead is noise against ~2ms of inserts per record.
const IMPORT_CHUNK = 500;

/** `--flag value`, with the repo-standard dataset when the value is omitted. */
function pathAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? resolve(value) : DEFAULT_DATASET;
}

/** The corrections file sits beside whichever dictionary path was actually used,
 *  never beside the default's: `--export-dict /tmp/mine.jsonl` must not write a
 *  developer's ad-hoc export back into the repo's dataset folder. */
function correctionsPathFor(dictionaryPath: string): string {
  return join(dirname(dictionaryPath), 'corrections.jsonl');
}

// A second process is a legitimate second composition root — but it reads the
// same config as the first rather than a copy-pasted connection string.
async function main(): Promise<void> {
  const { databaseUrl, poolMax } = loadConfig(process.env);
  const { db, close } = createDb(databaseUrl, {
    max: poolMax,
    onError: (error) => console.error('unexpected error on idle Postgres client', error),
  });
  // A flag rather than a second entry point: ADR 0002 names three composition
  // roots, and a fourth for a five-line command would be an ADR edit paying
  // for nothing. `process.argv` is not `process.env`, and this file is a
  // composition root either way.
  const reseed = process.argv.includes('--reseed');
  const exportTo = pathAfter('--export-dict');
  const importFrom = pathAfter('--import-dict');

  try {
    if (exportTo) {
      // No migration first: an export is a read, and running migrations would
      // make `--export-dict` write to a database the caller only asked to read.
      const records = await exportDictionary(db, {
        languageCode: TARGET_LANGUAGE,
        userLanguageCode: USER_LANGUAGE,
      });
      mkdirSync(dirname(exportTo), { recursive: true });
      writeFileSync(exportTo, toJsonl(records));
      console.log(`exported ${records.length} forms from ${databaseUrl}`);
      console.log(`written to ${exportTo}`);

      const corrections = await exportCorrections(db, { languageCode: TARGET_LANGUAGE });
      const correctionsPath = correctionsPathFor(exportTo);
      writeFileSync(correctionsPath, correctionsToJsonl(corrections));
      console.log(`exported ${corrections.length} corrections`);
      console.log(`written to ${correctionsPath}`);
      return;
    }

    await runMigrations(db);

    if (importFrom) {
      const records = fromJsonl(readFileSync(importFrom, 'utf8'));
      console.log(`restoring ${records.length} forms from ${importFrom}`);
      const result = await importDictionary(db, {
        records,
        languageCode: TARGET_LANGUAGE,
        userLanguageCode: USER_LANGUAGE,
        chunkSize: IMPORT_CHUNK,
        onProgress: (done, total) => console.log(`  ${done}/${total} forms`),
      });
      console.log(
        `restored ${result.records} forms into ${databaseUrl} — ` +
          `${result.lexemesCreated} lexemes written, the rest were already there ` +
          '(persistEntries is first-writer-wins, so nothing was overwritten).',
      );

      // A restore whose sibling file is absent restores the dictionary and reports
      // zero corrections rather than failing: the file is genuinely optional, and
      // it is empty on arrival.
      const correctionsPath = correctionsPathFor(importFrom);
      const correctionRecords = existsSync(correctionsPath)
        ? correctionsFromJsonl(readFileSync(correctionsPath, 'utf8'))
        : [];
      const restored = await importCorrections(db, {
        records: correctionRecords,
        languageCode: TARGET_LANGUAGE,
      });
      console.log(
        `restored ${restored.records} corrections from ${correctionsPath} ` +
          '(persistCorrection is first-writer-wins, so nothing was re-pointed).',
      );
      return;
    }

    if (reseed) {
      await reseedContent(db);
      console.log(`migrated and RESEEDED ${databaseUrl} — the dictionary was cleared first,`);
      console.log('so every looked-up word is gone as well as every recorded one.');
    } else {
      await seedContent(db);
      console.log(`migrated and seeded ${databaseUrl}`);
    }
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
