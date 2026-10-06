import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from '@jest/globals';
import { DIMENSIONS } from '@lang-tutor/core/domain';
import { sql } from 'drizzle-orm';

import { createDb } from '../../../src/db/client';
import { nextSource } from '../../../src/domain/session';
import { createSessionRepo } from '../../../src/repo/sessions';
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

describe('0009_enrollments', () => {
  it('gives every user one enrollment with the pair they had, and every session its enrollment', async () => {
    const db = await emptyDatabase();
    await runMigrationsFrom(db, migrationsUpTo('0008_variant_renderings'));

    await db.execute(sql`
      insert into users (id, username, display_name, age, native_language, target_language)
        values ('u_he', 'u_he', 'he native', 30, 'he', 'en'),
               ('u_en', 'u_en', 'en native', 40, 'en', 'he');
      insert into sessions (id, user_id) values
        ('00000000-0000-0000-0000-000000000001', 'u_he'),
        ('00000000-0000-0000-0000-000000000002', 'u_en');
    `);

    await runMigrations(db);

    const enrolled = await db.execute<{ user_id: string; source_language: string; target_language: string }>(
      sql`select user_id, source_language, target_language from enrollments order by user_id`,
    );
    expect(enrolled.rows).toEqual([
      { user_id: 'u_en', source_language: 'en', target_language: 'he' },
      { user_id: 'u_he', source_language: 'he', target_language: 'en' },
    ]);

    const orphans = await db.execute(sql`
      select s.id from sessions s
        left join enrollments e on e.id = s.enrollment_id and e.user_id = s.user_id
       where e.id is null`);
    expect(orphans.rows).toHaveLength(0);

    const column = await db.execute(sql`
      select 1 from information_schema.columns
       where table_name = 'users' and column_name = 'target_language'`);
    expect(column.rows).toHaveLength(0);
  });
});

describe('0011_session_status', () => {
  it('marks finished sessions completed, unfinished ones skipped, and every one seed', async () => {
    const db = await emptyDatabase();
    await runMigrationsFrom(db, migrationsUpTo('0010_vocabulary_entries'));

    await db.execute(sql`
      insert into users (id, username, display_name, age, native_language)
        values ('u_1', 'u_1', 'one', 30, 'he');
      insert into enrollments (id, user_id, source_language, target_language)
        values ('e_1', 'u_1', 'he', 'en');
      insert into sessions (id, user_id, enrollment_id, completed_at) values
        ('00000000-0000-0000-0000-000000000001', 'u_1', 'e_1', now()),
        ('00000000-0000-0000-0000-000000000002', 'u_1', 'e_1', null),
        ('00000000-0000-0000-0000-000000000003', 'u_1', 'e_1', null);
    `);

    await runMigrations(db);

    const rows = await db.execute<{ id: string; status: string; source: string }>(
      sql`select id, status, source from sessions order by id`,
    );
    expect(rows.rows).toEqual([
      { id: '00000000-0000-0000-0000-000000000001', status: 'completed', source: 'seed' },
      { id: '00000000-0000-0000-0000-000000000002', status: 'skipped', source: 'seed' },
      { id: '00000000-0000-0000-0000-000000000003', status: 'skipped', source: 'seed' },
    ]);

    // And the next session afterwards is `list`: the enrollment's newest
    // session is a closed one, so the seed is behind it.
    const latest = await db.transaction((tx) => createSessionRepo(tx).findLatest('e_1'));
    expect(latest).toMatchObject({ status: 'skipped', source: 'seed' });
    expect(nextSource(latest !== undefined)).toBe('list');
  });
});

describe('0012_sense_progress', () => {
  it('gives every existing entry five level 1 rows', async () => {
    const db = await emptyDatabase();
    await runMigrationsFrom(db, migrationsUpTo('0011_session_status'));

    await db.execute(sql`
      insert into users (id, username, display_name, age, native_language)
        values ('u_1', 'u_1', 'one', 30, 'he');
      insert into enrollments (id, user_id, source_language, target_language)
        values ('e_1', 'u_1', 'he', 'en');
      insert into dict_lexemes (id, language_code, lemma, part_of_speech)
        values ('l1', 'en', 'kite', 'noun');
      insert into dict_senses (id, lexeme_id, sense_code)
        values ('s1', 'l1', 'toy'), ('s2', 'l1', 'bird');
      insert into dict_variants (id, lexeme_id, language_code, form, kind, entry_rank)
        values ('v1', 'l1', 'en', 'kite', 'word', 0);
      insert into dict_var_translations (variant_id, sense_id, user_language_code, translation, rank)
        values ('v1', 's1', 'he', 'עפיפון', 0), ('v1', 's2', 'he', 'דיה', 1);
      insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, variant_id)
        values ('e_1', 's1', 'l1', 'v1'), ('e_1', 's2', 'l1', 'v1');
    `);

    await runMigrations(db);

    const rows = await db.execute<{
      sense_id: string;
      dimension: string;
      level: number;
      last_step_on: string | null;
      last_wrong_on: string | null;
    }>(sql`select sense_id, dimension, level, last_step_on, last_wrong_on
           from sense_progress order by sense_id, dimension`);
    expect(rows.rows).toHaveLength(10);
    for (const sense of ['s1', 's2']) {
      expect(rows.rows.filter((r) => r.sense_id === sense).map((r) => r.dimension).sort()).toEqual(
        [...DIMENSIONS].sort(),
      );
    }
    expect(rows.rows.every((r) => r.level === 1 && r.last_step_on === null && r.last_wrong_on === null)).toBe(true);
  });
});

describe('0013_vocabulary_entries_lemma', () => {
  it("gives every existing entry its lexeme's lemma", async () => {
    const db = await emptyDatabase();
    await runMigrationsFrom(db, migrationsUpTo('0012_sense_progress'));

    await db.execute(sql`
      insert into users (id, username, display_name, age, native_language)
        values ('u_1', 'u_1', 'one', 30, 'he');
      insert into enrollments (id, user_id, source_language, target_language)
        values ('e_1', 'u_1', 'he', 'en');
      insert into dict_lexemes (id, language_code, lemma, part_of_speech)
        values ('l1', 'en', 'kite', 'noun'), ('l2', 'en', 'kite', 'verb');
      insert into dict_senses (id, lexeme_id, sense_code)
        values ('s1', 'l1', 'toy'), ('s2', 'l2', 'fly');
      insert into dict_variants (id, lexeme_id, language_code, form, kind, entry_rank)
        values ('v1', 'l1', 'en', 'kite', 'word', 0), ('v2', 'l2', 'en', 'kite', 'word', 1);
      insert into dict_var_translations (variant_id, sense_id, user_language_code, translation, rank)
        values ('v1', 's1', 'he', 'עפיפון', 0), ('v2', 's2', 'he', 'להטיס', 0);
      insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, variant_id)
        values ('e_1', 's1', 'l1', 'v1'), ('e_1', 's2', 'l2', 'v2');
    `);

    await runMigrations(db);

    const rows = await db.execute<{ sense_id: string; lemma: string }>(
      sql`select sense_id, lemma from vocabulary_entries order by sense_id`,
    );
    expect(rows.rows).toEqual([
      { sense_id: 's1', lemma: 'kite' },
      { sense_id: 's2', lemma: 'kite' },
    ]);
  });
});

// Phase 23, Review Focus 5: a session stored before 0015 loads and takes
// answers unchanged.
describe('0015_question_types', () => {
  it('keeps every stored question and answer, and the session still answers', async () => {
    const db = await emptyDatabase();
    await runMigrationsFrom(db, migrationsUpTo('0014_italian_target'));

    const options = (right: string) =>
      JSON.stringify([
        { position: 0, text: right, is_correct: true },
        { position: 1, text: 'א', is_correct: false },
        { position: 2, text: 'ב', is_correct: false },
        { position: 3, text: 'ג', is_correct: false },
      ]);
    await db.execute(sql`
      insert into users (id, username, display_name, age, native_language)
        values ('u_1', 'u_1', 'one', 30, 'he');
      insert into enrollments (id, user_id, source_language, target_language)
        values ('e_1', 'u_1', 'he', 'en');
      insert into dict_lexemes (id, language_code, lemma, part_of_speech)
        values ('l1', 'en', 'kite', 'noun');
      insert into dict_senses (id, lexeme_id, sense_code)
        values ('s1', 'l1', 'toy');
      insert into dict_variants (id, lexeme_id, language_code, form, kind, entry_rank)
        values ('v1', 'l1', 'en', 'kite', 'word', 0);
      insert into dict_var_translations (variant_id, sense_id, user_language_code, translation, rank)
        values ('v1', 's1', 'he', 'עפיפון', 0);
    `);
    await db.execute(sql`
      insert into questions (id, user_id, enrollment_id, sense_id, prompt_variant_id, target_language, user_language_code, type, options)
        values ('q1', 'u_1', 'e_1', 's1', 'v1', 'en', 'he', 'multiple_choice', ${options('עפיפון')}::jsonb),
               ('q2', 'u_1', 'e_1', 's1', 'v1', 'en', 'he', 'multiple_choice', ${options('דיה')}::jsonb)`);
    const [session] = (
      await db.execute<{ id: string }>(sql`
        insert into sessions (user_id, enrollment_id, status, source)
          values ('u_1', 'e_1', 'ready', 'list') returning id`)
    ).rows;
    await db.execute(sql`
      insert into session_questions (session_id, position, question_id, option_order)
        values (${session.id}, 0, 'q1', '{2,0,3,1}'), (${session.id}, 1, 'q2', '{0,1,2,3}')`);
    await db.execute(sql`
      insert into answers (session_id, position, question_id, selected_option_position)
        values (${session.id}, 0, 'q1', 0)`);

    await runMigrations(db);

    await db.transaction(async (tx) => {
      const repo = createSessionRepo(tx);
      const before = await repo.loadSession(session.id);
      expect(before!.questions.map((q) => q.type)).toEqual(['multiple_choice', 'multiple_choice']);
      expect(before!.questions[0]).toMatchObject({ question: 'kite', options: ['ב', 'עפיפון', 'ג', 'א'], correct_option: 1 });
      expect(before!.answers).toEqual([{ question_id: 'q1', is_correct: true, answer_string: 'עפיפון' }]);

      await repo.insertAnswer(session.id, 1, 'q2', { displayIndex: 2 });
      expect((await repo.loadSession(session.id))!.answers[1]).toEqual({
        question_id: 'q2',
        is_correct: false,
        answer_string: 'ב',
      });
    });
  });
});
