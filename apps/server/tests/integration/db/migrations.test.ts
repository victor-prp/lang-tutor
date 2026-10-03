import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createDb } from '../../../src/db/client';
import { runMigrations, runMigrationsFrom } from '../../../src/db/migrate';
import { ADMIN_URL, testDbName, urlFor } from '../../support/dbNames';
import { migrationsUpTo } from '../../support/migrations';

/**
 * Each test builds an EMPTY database (no template — the template is already
 * fully migrated), migrates it to just before the migration under test,
 * inserts rows the old schema allowed, then runs the rest. The name comes from
 * testDbName, so globalSetup's sweep reclaims it.
 */
const opened: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  while (opened.length > 0) await opened.pop()!.close();
});

async function emptyDatabase() {
  const name = testDbName(expect.getState().currentTestName ?? 'migration', randomUUID().slice(0, 8));
  const admin = createDb(ADMIN_URL, { max: 1, onError: () => {} });
  try {
    await admin.db.execute(sql.raw(`create database ${name}`));
  } finally {
    await admin.close();
  }
  const handle = createDb(urlFor(name), { onError: () => {} });
  opened.push(handle);
  return handle.db;
}

describe('0008_variant_renderings', () => {
  it('gives every rendered variant one row per language it has translations in', async () => {
    const db = await emptyDatabase();
    await runMigrationsFrom(db, migrationsUpTo('0007_dict_corrections'));

    await db.execute(sql`
      insert into dict_lexemes (id, language_code, lemma, part_of_speech, sense_version)
        values ('lx-en', 'en', 'window', 'noun', 2), ('lx-he', 'he', 'חלון', 'noun', 1);
      insert into dict_variants (id, lexeme_id, language_code, form, kind, entry_rank, rendered_sense_version)
        values ('v-en', 'lx-en', 'en', 'window', 'word', 0, 2),
               ('v-he', 'lx-he', 'he', 'חלון', 'word', 0, 1);
      insert into dict_senses (id, lexeme_id, sense_code)
        values ('s-en-1', 'lx-en', 'opening'), ('s-en-2', 'lx-en', 'period'),
               ('s-he-1', 'lx-he', 'opening');
      insert into dict_var_translations (variant_id, sense_id, user_language_code, translation, rank)
        values ('v-en', 's-en-1', 'he', 'חלון', 0), ('v-en', 's-en-2', 'he', 'חלון זמן', 1),
               ('v-he', 's-he-1', 'en', 'window', 0);
    `);

    await runMigrations(db);

    const rows = await db.execute<{ variant_id: string; user_language_code: string; rendered_sense_version: number }>(
      sql`select variant_id, user_language_code, rendered_sense_version
            from dict_variant_renderings order by variant_id`,
    );
    expect(rows.rows).toEqual([
      { variant_id: 'v-en', user_language_code: 'he', rendered_sense_version: 2 },
      { variant_id: 'v-he', user_language_code: 'en', rendered_sense_version: 1 },
    ]);

    const column = await db.execute(sql`
      select 1 from information_schema.columns
       where table_name = 'dict_variants' and column_name = 'rendered_sense_version'`);
    expect(column.rows).toHaveLength(0);
  });
});
