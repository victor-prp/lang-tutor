import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MIGRATIONS_FOLDER } from '../../src/db/migrate';

/**
 * A copy of the migrations folder whose journal ends at `tag`. Drizzle's
 * migrator applies what the journal lists and nothing else, and applies only
 * migrations newer than the last one recorded — so migrating a database with
 * this folder, inserting rows, then migrating with the real folder runs exactly
 * the migrations after `tag` against those rows.
 */
export function migrationsUpTo(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lang-tutor-migrations-'));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });

  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  const index = journal.entries.findIndex((entry) => entry.tag === tag);
  if (index < 0) throw new Error(`no migration tagged ${tag}`);
  journal.entries = journal.entries.slice(0, index + 1);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return dir;
}
