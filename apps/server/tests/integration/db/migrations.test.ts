import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from '@jest/globals';
import { DIMENSIONS } from '@lang-tutor/core/domain';
import { sql } from 'drizzle-orm';

import { createDb } from '../../../src/db/client';
import { splitTranslation } from '../../../src/domain/glosses';
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

// Phase 24, Review Focus 4: a session stored before 0016 loads and takes
// answers unchanged.
describe('0016_listening_variety', () => {
  it('keeps every stored question and answer, and a typed answer still lands', async () => {
    const db = await emptyDatabase();
    await runMigrationsFrom(db, migrationsUpTo('0015_question_types'));

    const options = JSON.stringify([
      { position: 0, text: 'עפיפון', is_correct: true },
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
        values ('q1', 'u_1', 'e_1', 's1', 'v1', 'en', 'he', 'multiple_choice', ${options}::jsonb)`);
    await db.execute(sql`
      insert into questions (id, user_id, enrollment_id, sense_id, prompt_variant_id, target_language, user_language_code, type, prompt, alternatives)
        values ('q2', 'u_1', 'e_1', 's1', 'v1', 'en', 'he', 'typed_translation', 'עפיפון', '{}')`);
    const [session] = (
      await db.execute<{ id: string }>(sql`
        insert into sessions (user_id, enrollment_id, status, source)
          values ('u_1', 'e_1', 'ready', 'list') returning id`)
    ).rows;
    await db.execute(sql`
      insert into session_questions (session_id, position, question_id, option_order)
        values (${session.id}, 0, 'q1', '{0,1,2,3}'), (${session.id}, 1, 'q2', '{}')`);
    await db.execute(sql`
      insert into answers (session_id, position, question_id, selected_option_position)
        values (${session.id}, 0, 'q1', 0)`);

    await runMigrations(db);

    await db.transaction(async (tx) => {
      const repo = createSessionRepo(tx);
      const before = await repo.loadSession(session.id);
      expect(before!.questions.map((q) => q.type)).toEqual(['multiple_choice', 'typed_translation']);
      expect(before!.answers).toEqual([{ question_id: 'q1', is_correct: true, answer_string: 'עפיפון' }]);

      await repo.insertAnswer(session.id, 1, 'q2', { text: 'kite', verdict: 'exact' });
      expect((await repo.loadSession(session.id))!.answers[1]).toMatchObject({ question_id: 'q2', is_correct: true });
    });
  });
});

// Phase 25, Review Focus 5: questions, sessions and answers stored before 0017
// load and take answers unchanged, and a speaking row of the wrong shape is
// refused.
describe('0017_speaking_cards', () => {
  it('keeps every stored question and answer, takes the speaking rows, and refuses the wrong shapes', async () => {
    const db = await emptyDatabase();
    await runMigrationsFrom(db, migrationsUpTo('0016_listening_variety'));

    const options = JSON.stringify([
      { position: 0, text: 'עפיפון', is_correct: true },
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
    // One question of each phase 24 type.
    const insertQuestion = (id: string, type: string, columns: { options?: string; prompt?: string; alternatives?: string; tiles?: string }) =>
      db.execute(sql`
        insert into questions (id, user_id, enrollment_id, sense_id, prompt_variant_id, target_language, user_language_code, type, options, prompt, alternatives, tiles)
          values (${id}, 'u_1', 'e_1', 's1', 'v1', 'en', 'he', ${type},
            ${columns.options ?? null}::jsonb, ${columns.prompt ?? null}, ${columns.alternatives ?? null}::text[], ${columns.tiles ?? null}::text[])`);
    await insertQuestion('q1', 'multiple_choice', { options });
    await insertQuestion('q2', 'reverse_choice', { options, prompt: 'עפיפון' });
    await insertQuestion('q3', 'typed_translation', { prompt: 'עפיפון', alternatives: '{}' });
    await insertQuestion('q4', 'listen_choice', { options });
    await insertQuestion('q5', 'dictation', { prompt: 'עפיפון' });
    await insertQuestion('q6', 'matching', { options });
    await insertQuestion('q7', 'letter_tiles', { prompt: 'עפיפון', tiles: '{k,i,t,e,s}' });
    const [session] = (
      await db.execute<{ id: string }>(sql`
        insert into sessions (user_id, enrollment_id, status, source)
          values ('u_1', 'e_1', 'ready', 'list') returning id`)
    ).rows;
    await db.execute(sql`
      insert into session_questions (session_id, position, question_id, option_order)
        values (${session.id}, 0, 'q1', '{0,1,2,3}'), (${session.id}, 1, 'q3', '{}'),
               (${session.id}, 2, 'q3', '{}'), (${session.id}, 3, 'q3', '{}'), (${session.id}, 4, 'q3', '{}'),
               (${session.id}, 5, 'q1', '{0,1,2,3}'), (${session.id}, 6, 'q3', '{}')`);
    await db.execute(sql`
      insert into answers (session_id, position, question_id, selected_option_position)
        values (${session.id}, 0, 'q1', 0)`);
    // One typed answer of each phase 23 verdict.
    await db.execute(sql`
      insert into answers (session_id, position, question_id, typed_text, verdict)
        values (${session.id}, 1, 'q3', 'kite', 'exact'), (${session.id}, 2, 'q3', 'kyte', 'near_miss'),
               (${session.id}, 3, 'q3', 'toy', 'alternative'), (${session.id}, 4, 'q3', 'bird', 'wrong')`);

    await runMigrations(db);

    const kept = await db.execute<{ id: string; type: string }>(sql`select id, type from questions order by id`);
    expect(kept.rows.map((r) => r.type)).toEqual([
      'multiple_choice',
      'reverse_choice',
      'typed_translation',
      'listen_choice',
      'dictation',
      'matching',
      'letter_tiles',
    ]);
    const stored = await db.execute<{ position: number; verdict: string | null }>(
      sql`select position, verdict from answers order by position`,
    );
    expect(stored.rows).toEqual([
      { position: 0, verdict: null },
      { position: 1, verdict: 'exact' },
      { position: 2, verdict: 'near_miss' },
      { position: 3, verdict: 'alternative' },
      { position: 4, verdict: 'wrong' },
    ]);

    // The new shapes.
    await insertQuestion('r1', 'read_aloud', { prompt: 'עפיפון' });
    await insertQuestion('r2', 'say_translation', { prompt: 'עפיפון', alternatives: '{}' });
    await expect(insertQuestion('r3', 'read_aloud', { prompt: 'עפיפון', alternatives: '{}' })).rejects.toMatchObject({ cause: { constraint: 'questions_shape_valid' } });
    await expect(insertQuestion('r4', 'say_translation', { prompt: 'עפיפון' })).rejects.toMatchObject({ cause: { constraint: 'questions_shape_valid' } });

    // The new verdicts.
    await db.execute(sql`
      insert into session_questions (session_id, position, question_id, option_order)
        values (${session.id}, 7, 'r1', '{}'), (${session.id}, 8, 'r2', '{}'), (${session.id}, 9, 'r1', '{}'),
               (${session.id}, 10, 'r2', '{}')`);
    const answer = (position: number, questionId: string, verdict: string) =>
      db.execute(sql`
        insert into answers (session_id, position, question_id, typed_text, verdict)
          values (${session.id}, ${position}, ${questionId}, '', ${verdict})`);
    await answer(7, 'r1', 'understood');
    await answer(8, 'r2', 'gave_up');
    await answer(9, 'r1', 'skipped');
    await expect(answer(10, 'r2', 'unheard')).rejects.toMatchObject({ cause: { constraint: 'answers_verdict_known' } });

    // A stored session still loads and takes an answer.
    await db.transaction(async (tx) => {
      const repo = createSessionRepo(tx);
      const before = await repo.loadSession(session.id);
      expect(before!.answers.slice(0, 5)).toEqual([
        { question_id: 'q1', is_correct: true, answer_string: 'עפיפון' },
        { question_id: 'q3', is_correct: true, answer_string: 'kite', verdict: 'exact' },
        { question_id: 'q3', is_correct: true, answer_string: 'kyte', verdict: 'near_miss' },
        { question_id: 'q3', is_correct: true, answer_string: 'toy', verdict: 'alternative' },
        { question_id: 'q3', is_correct: false, answer_string: 'bird', verdict: 'wrong' },
      ]);

      await repo.insertAnswer(session.id, 5, 'q1', { displayIndex: 1 });
      await repo.insertAnswer(session.id, 6, 'q3', { text: 'kite', verdict: 'exact' });
      const after = await repo.loadSession(session.id);
      expect(after!.answers.slice(5, 7)).toEqual([
        { question_id: 'q1', is_correct: false, answer_string: 'א' },
        { question_id: 'q3', is_correct: true, answer_string: 'kite', verdict: 'exact' },
      ]);
    });
  });
});

// Phase 27 Part A: stored questions and answers survive 0019, a meaning-recall
// row takes a prompt only, and a judged answer may be 300 characters.
describe('0019_typed_meaning', () => {
  it('keeps every existing question and answer, and admits a typed_meaning question with a prompt only', async () => {
    const db = await emptyDatabase();
    await runMigrationsFrom(db, migrationsUpTo('0018_photo_imports'));

    const options = JSON.stringify([
      { position: 0, text: 'עפיפון', is_correct: true },
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
    const insertQuestion = (id: string, type: string, columns: { options?: string; prompt?: string; alternatives?: string; tiles?: string }) =>
      db.execute(sql`
        insert into questions (id, user_id, enrollment_id, sense_id, prompt_variant_id, target_language, user_language_code, type, options, prompt, alternatives, tiles)
          values (${id}, 'u_1', 'e_1', 's1', 'v1', 'en', 'he', ${type},
            ${columns.options ?? null}::jsonb, ${columns.prompt ?? null}, ${columns.alternatives ?? null}::text[], ${columns.tiles ?? null}::text[])`);
    // One question of each existing type.
    await insertQuestion('q1', 'multiple_choice', { options });
    await insertQuestion('q2', 'reverse_choice', { options, prompt: 'עפיפון' });
    await insertQuestion('q3', 'typed_translation', { prompt: 'עפיפון', alternatives: '{}' });
    await insertQuestion('q4', 'listen_choice', { options });
    await insertQuestion('q5', 'dictation', { prompt: 'עפיפון' });
    await insertQuestion('q6', 'matching', { options });
    await insertQuestion('q7', 'letter_tiles', { prompt: 'עפיפון', tiles: '{k,i,t,e,s}' });
    await insertQuestion('q8', 'read_aloud', { prompt: 'עפיפון' });
    await insertQuestion('q9', 'say_translation', { prompt: 'עפיפון', alternatives: '{}' });
    const [session] = (
      await db.execute<{ id: string }>(sql`
        insert into sessions (user_id, enrollment_id, status, source)
          values ('u_1', 'e_1', 'ready', 'list') returning id`)
    ).rows;
    await db.execute(sql`
      insert into session_questions (session_id, position, question_id, option_order)
        values (${session.id}, 0, 'q3', '{}')`);
    const hundred = 'a'.repeat(100);
    await db.execute(sql`
      insert into answers (session_id, position, question_id, typed_text, verdict)
        values (${session.id}, 0, 'q3', ${hundred}, 'exact')`);

    await runMigrations(db);

    const kept = await db.execute<{ type: string }>(sql`select type from questions order by id`);
    expect(kept.rows.map((r) => r.type)).toEqual([
      'multiple_choice',
      'reverse_choice',
      'typed_translation',
      'listen_choice',
      'dictation',
      'matching',
      'letter_tiles',
      'read_aloud',
      'say_translation',
    ]);
    const stored = await db.execute<{ typed_text: string; verdict: string }>(
      sql`select typed_text, verdict from answers`,
    );
    expect(stored.rows).toEqual([{ typed_text: hundred, verdict: 'exact' }]);

    // The new shape: a prompt and nothing else.
    await insertQuestion('r1', 'typed_meaning', { prompt: 'עפיפון' });
    await expect(insertQuestion('r2', 'typed_meaning', { prompt: 'עפיפון', options })).rejects.toMatchObject({ cause: { constraint: 'questions_shape_valid' } });
    await expect(insertQuestion('r3', 'typed_meaning', { prompt: 'עפיפון', alternatives: '{}' })).rejects.toMatchObject({ cause: { constraint: 'questions_shape_valid' } });
    await expect(insertQuestion('r4', 'typed_meaning', {})).rejects.toMatchObject({ cause: { constraint: 'questions_shape_valid' } });

    // A judged answer is at most 300 characters.
    const answer = (position: number, length: number) =>
      db.execute(sql`
        insert into answers (session_id, position, question_id, typed_text, verdict)
          values (${session.id}, ${position}, 'r1', ${'ב'.repeat(length)}, 'exact')`);
    await db.execute(sql`
      insert into session_questions (session_id, position, question_id, option_order)
        values (${session.id}, 4, 'r1', '{}'), (${session.id}, 5, 'r1', '{}')`);
    await answer(4, 300);
    await expect(answer(5, 301)).rejects.toMatchObject({ cause: { constraint: 'answers_typed_text_length' } });
  });
});

// Phase 27 Part B (Review Focus 5): rows stored before 0020 keep loading, each
// sentence type takes its four columns, and a sentence column anywhere else, or
// a gap outside its sentence, is refused.
describe('0020_sentence_cards', () => {
  it('keeps every existing question, admits the three sentence types, and refuses a stray or out-of-range sentence', async () => {
    const db = await emptyDatabase();
    await runMigrationsFrom(db, migrationsUpTo('0019_typed_meaning'));

    const options = JSON.stringify([
      { position: 0, text: 'kite', is_correct: true },
      { position: 1, text: 'a', is_correct: false },
      { position: 2, text: 'b', is_correct: false },
      { position: 3, text: 'c', is_correct: false },
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
    type Columns = {
      options?: string;
      prompt?: string;
      alternatives?: string;
      tiles?: string;
      sentence?: string;
      translation?: string;
      gapStart?: number;
      gapEnd?: number;
    };
    const insertQuestion = (id: string, type: string, c: Columns) =>
      db.execute(sql`
        insert into questions (id, user_id, enrollment_id, sense_id, prompt_variant_id, target_language, user_language_code, type, options, prompt, alternatives, tiles,
                               sentence, sentence_translation, gap_start, gap_end)
          values (${id}, 'u_1', 'e_1', 's1', 'v1', 'en', 'he', ${type},
            ${c.options ?? null}::jsonb, ${c.prompt ?? null}, ${c.alternatives ?? null}::text[], ${c.tiles ?? null}::text[],
            ${c.sentence ?? null}, ${c.translation ?? null}, ${c.gapStart ?? null}::int, ${c.gapEnd ?? null}::int)`);
    // Before 0019 the table has no sentence columns.
    await db.execute(sql`
      insert into questions (id, user_id, enrollment_id, sense_id, prompt_variant_id, target_language, user_language_code, type, options, prompt, alternatives)
        values ('q1', 'u_1', 'e_1', 's1', 'v1', 'en', 'he', 'multiple_choice', ${options}::jsonb, null, null),
               ('q2', 'u_1', 'e_1', 's1', 'v1', 'en', 'he', 'typed_meaning', null, 'עפיפון', null),
               ('q3', 'u_1', 'e_1', 's1', 'v1', 'en', 'he', 'say_translation', null, 'עפיפון', '{}')`);

    await runMigrations(db);

    const kept = await db.execute<{ type: string; sentence: string | null; gap_start: number | null }>(
      sql`select type, sentence, gap_start from questions order by id`,
    );
    expect(kept.rows).toEqual([
      { type: 'multiple_choice', sentence: null, gap_start: null },
      { type: 'typed_meaning', sentence: null, gap_start: null },
      { type: 'say_translation', sentence: null, gap_start: null },
    ]);

    // Each sentence type with its columns: 'I fly a kite.', the gap is 'kite'.
    const sentence = { sentence: 'I fly a kite.', translation: 'אני מעיף עפיפון.', gapStart: 8, gapEnd: 12 };
    await insertQuestion('c1', 'cloze_choice', { ...sentence, options, prompt: 'עפיפון' });
    await insertQuestion('c2', 'cloze_typed', { ...sentence, prompt: 'עפיפון', alternatives: '{}' });
    await insertQuestion('c3', 'sentence_translation', { ...sentence, prompt: 'עפיפון' });
    const stored = await db.execute<{ id: string; sentence: string; gap_start: number; gap_end: number }>(
      sql`select id, sentence, gap_start, gap_end from questions where id like 'c%' order by id`,
    );
    expect(stored.rows.map((r) => [r.id, r.sentence.slice(r.gap_start, r.gap_end)])).toEqual([
      ['c1', 'kite'],
      ['c2', 'kite'],
      ['c3', 'kite'],
    ]);

    // The shapes of the three.
    const shape = { cause: { constraint: 'questions_shape_valid' } };
    await expect(insertQuestion('s1', 'cloze_choice', { ...sentence, prompt: 'עפיפון' })).rejects.toMatchObject(shape);
    await expect(insertQuestion('s2', 'cloze_choice', { ...sentence, options, prompt: 'עפיפון', alternatives: '{}' })).rejects.toMatchObject(shape);
    await expect(insertQuestion('s3', 'cloze_typed', { ...sentence, prompt: 'עפיפון', options, alternatives: '{}' })).rejects.toMatchObject(shape);
    await expect(insertQuestion('s4', 'cloze_typed', { ...sentence, prompt: 'עפיפון', alternatives: '{a,b,c,d,e,f}' })).rejects.toMatchObject(shape);
    await expect(insertQuestion('s5', 'sentence_translation', { ...sentence, prompt: 'עפיפון', alternatives: '{}' })).rejects.toMatchObject(shape);
    await expect(insertQuestion('s6', 'sentence_translation', { ...sentence, prompt: 'עפיפון', tiles: '{a,b,c,d,e}' })).rejects.toMatchObject(shape);

    // A sentence column on any other type, or a sentence type missing one.
    const valid = { cause: { constraint: 'questions_sentence_valid' } };
    await expect(insertQuestion('x1', 'multiple_choice', { options, sentence: 'I fly a kite.' })).rejects.toMatchObject(valid);
    await expect(insertQuestion('x2', 'typed_meaning', { prompt: 'עפיפון', ...sentence })).rejects.toMatchObject(valid);
    await expect(insertQuestion('x3', 'sentence_translation', { prompt: 'עפיפון' })).rejects.toMatchObject(valid);
    await expect(insertQuestion('x4', 'cloze_typed', { ...sentence, gapStart: undefined, prompt: 'עפיפון', alternatives: '{}' })).rejects.toMatchObject(valid);

    // The gap lies inside the sentence.
    const outside = (id: string, gapStart: number, gapEnd: number) =>
      insertQuestion(id, 'sentence_translation', { ...sentence, prompt: 'עפיפון', gapStart, gapEnd });
    await expect(outside('g1', 8, 14)).rejects.toMatchObject(valid);
    await expect(outside('g2', -1, 4)).rejects.toMatchObject(valid);
    await expect(outside('g3', 5, 5)).rejects.toMatchObject(valid);
    await outside('g4', 8, 13);
  });
});

// Phase 28: every entry saved before 0021 was saved by its list's owner.
describe('0021_enrollment_grants', () => {
  it("backfills added_by_user_id to the list's owner", async () => {
    const db = await emptyDatabase();
    await runMigrationsFrom(db, migrationsUpTo('0020_sentence_cards'));
    await db.execute(sql`
      insert into users (id, username, display_name, age, native_language)
        values ('u_1', 'u_1', 'one', 30, 'he'), ('u_2', 'u_2', 'two', 30, 'he');
      insert into enrollments (id, user_id, source_language, target_language)
        values ('e_1', 'u_1', 'he', 'en'), ('e_2', 'u_2', 'he', 'en');
      insert into dict_lexemes (id, language_code, lemma, part_of_speech)
        values ('l1', 'en', 'kite', 'noun');
      insert into dict_senses (id, lexeme_id, sense_code)
        values ('s1', 'l1', 'toy');
      insert into dict_variants (id, lexeme_id, language_code, form, kind, entry_rank)
        values ('v1', 'l1', 'en', 'kite', 'word', 0);
      insert into dict_var_translations (variant_id, sense_id, user_language_code, translation, rank)
        values ('v1', 's1', 'he', 'עפיפון', 0);
      insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, lemma, variant_id)
        values ('e_1', 's1', 'l1', 'kite', 'v1'), ('e_2', 's1', 'l1', 'kite', 'v1');
    `);

    await runMigrations(db);

    const rows = await db.execute<{ enrollment_id: string; added_by_user_id: string }>(
      sql`select enrollment_id, added_by_user_id from vocabulary_entries order by enrollment_id`,
    );
    expect(rows.rows).toEqual([
      { enrollment_id: 'e_1', added_by_user_id: 'u_1' },
      { enrollment_id: 'e_2', added_by_user_id: 'u_2' },
    ]);
  });
});

// Lane 0's shapes (Task 1's unit test holds their expected values): every comma
// list, every parenthetical, a sample of compounds, and the edge cases.
const TRANSLATION_SHAPES = [
  'להימנע מ-, להתחמק מ-', 'שפל, נחות', 'לבסס, להשתית', 'בסיס, יסוד', 'מאוד, נורא', 'ארור, מקולל',
  'עקוב מדם, אלים', 'מדמם, מלא דם', 'קומבינציה, צירוף', 'שילוב, צירוף', 'לשלב, לאחד', 'לשלב, להכיל',
  'להלחין, לחבר', 'להרכיב, להוות', 'לפתח, לבנות', 'לפתח, לרכוש', 'לפתח, ליצור', 'רם, חזק', 'ראשי, עיקרי',
  'צינור ראשי, קו ראשי', 'להורות, לפקוד', 'להשתפר, להתאושש', 'לקלוט, ללמוד', 'ראוותנות, מהומה, בלבול',
  'לבלבל, להרשים בראוותנות', 'לזנק, לעלות בחדות', 'לקבע במסמרים, לתקוע יתד', 'לסרב, לדחות',
  'להנמיך, להפחית', 'טוב, בסדר', 'בסיס (צבאי)', 'בסיס (כימיה)', 'אח (במסדר דתי)', 'להנחית (כדור בווֹליבול)',
  'כבד, עשיר (בטעמים)', 'עמוק, עשיר (בגוון/צליל)', 'לסמם (משקה), להוסיף חומר (למשקה)', 'אח (חבר, רע)',
  'בית קפה', 'בלתי אפשרי', 'to deposit', 'ha scritto', 'א, ב / ג', 'רם, רָם, חזק, חזק', '(הערה)',
  // Not lane 0's: a no-break space after the comma, which JavaScript's \s trims and Postgres's does not.
  'א,\u00a0ב',
];

describe('0022_glosses', () => {
  it('cleans every rendering and gives every rendered sense one gloss per learner language', async () => {
    const db = await emptyDatabase();
    await runMigrationsFrom(db, migrationsUpTo('0021_enrollment_grants'));
    await db.execute(sql`
      insert into dict_lexemes (id, language_code, lemma, part_of_speech) values
        ('l_mouse', 'en', 'mouse', 'noun'), ('l_car', 'en', 'car', 'noun'), ('l_finger', 'en', 'finger', 'noun'),
        ('l_base', 'en', 'base', 'noun'), ('l_comb', 'en', 'combination', 'noun'), ('l_window', 'he', 'חלון', 'noun');
      insert into dict_senses (id, lexeme_id, sense_code) values
        ('s_rodent', 'l_mouse', 'rodent'), ('s_device', 'l_mouse', 'device'), ('s_vehicle', 'l_car', 'vehicle'),
        ('s_body', 'l_finger', 'body_part'), ('s_military', 'l_base', 'military'), ('s_chemistry', 'l_base', 'chemistry'),
        ('s_lock', 'l_comb', 'lock_code'), ('s_mix', 'l_comb', 'mixture'), ('s_window', 'l_window', 'opening');
      insert into dict_variants (id, lexeme_id, language_code, form, kind, entry_rank) values
        ('v_mouse', 'l_mouse', 'en', 'mouse', 'word', 0), ('v_car', 'l_car', 'en', 'car', 'word', 0),
        ('v_cars', 'l_car', 'en', 'cars', 'word', 0), ('v_fingers', 'l_finger', 'en', 'fingers', 'word', 0),
        ('v_base', 'l_base', 'en', 'base', 'word', 0), ('v_comb', 'l_comb', 'en', 'combination', 'word', 0),
        ('v_window', 'l_window', 'he', 'חלון', 'word', 0);
      insert into dict_var_translations (variant_id, sense_id, user_language_code, translation, rank) values
        ('v_mouse', 's_rodent', 'he', 'עכבר', 0), ('v_mouse', 's_device', 'he', 'עַכְבָּר', 1),
        ('v_car', 's_vehicle', 'he', 'מכונית, רכב, אוטו', 1), ('v_cars', 's_vehicle', 'he', 'מכוניות, רכבים', 0),
        ('v_fingers', 's_body', 'he', 'אצבעות', 0),
        ('v_base', 's_military', 'he', 'בסיס (צבאי)', 0), ('v_base', 's_chemistry', 'he', 'בסיס (כימיה)', 1),
        ('v_comb', 's_lock', 'he', 'קומבינציה, צירוף', 0), ('v_comb', 's_mix', 'he', 'שילוב, צירוף', 1),
        ('v_window', 's_window', 'en', 'window', 0), ('v_window', 's_window', 'ru', 'окно', 0);
    `);

    await runMigrations(db);

    const renderings = await db.execute<{ variant_id: string; sense_id: string; translation: string; gloss: string; alternatives: string[] }>(sql`
      select variant_id, sense_id, translation, gloss, alternatives from dict_var_translations
      where user_language_code = 'he' and variant_id in ('v_car', 'v_cars', 'v_base') order by variant_id, sense_id`);
    expect(renderings.rows).toEqual([
      { variant_id: 'v_base', sense_id: 's_chemistry', translation: 'בסיס', gloss: 'בסיס', alternatives: [] },
      { variant_id: 'v_base', sense_id: 's_military', translation: 'בסיס', gloss: 'בסיס', alternatives: [] },
      { variant_id: 'v_car', sense_id: 's_vehicle', translation: 'מכונית', gloss: 'מכונית', alternatives: ['רכב', 'אוטו'] },
      { variant_id: 'v_cars', sense_id: 's_vehicle', translation: 'מכוניות', gloss: 'מכוניות', alternatives: ['רכבים'] },
    ]);

    const glosses = await db.execute<{ lemma: string; lang: string; key: string; alternatives: string[]; members: string[] }>(sql`
      select l.lemma, g.user_language_code as lang, g.key, g.alternatives,
             array_agg(m.sense_id order by m.sense_id) as members
      from dict_glosses g join dict_lexemes l on l.id = g.lexeme_id
      join dict_sense_glosses m on m.gloss_id = g.id
      group by l.lemma, g.user_language_code, g.key, g.alternatives
      order by l.lemma, g.user_language_code, g.key`);
    expect(glosses.rows).toEqual([
      // The parenthetical was the only difference: one target word, one gloss (D3).
      { lemma: 'base', lang: 'he', key: 'בסיס', alternatives: [], members: ['s_chemistry', 's_military'] },
      // Keyed from the lemma form, though `car` ranks the sense below `cars` does, and its
      // alternatives kept in the rendering's order; `cars`' plural is not a citation form.
      { lemma: 'car', lang: 'he', key: 'מכונית', alternatives: ['רכב', 'אוטו'], members: ['s_vehicle'] },
      { lemma: 'combination', lang: 'he', key: 'קומבינציה', alternatives: ['צירוף'], members: ['s_lock'] },
      { lemma: 'combination', lang: 'he', key: 'שילוב', alternatives: ['צירוף'], members: ['s_mix'] },
      // Only an inflected form was ever rendered: the key is inflected until D6 renames it.
      { lemma: 'finger', lang: 'he', key: 'אצבעות', alternatives: [], members: ['s_body'] },
      // Spelled as the lowest-ranked member wrote it.
      { lemma: 'mouse', lang: 'he', key: 'עכבר', alternatives: [], members: ['s_device', 's_rodent'] },
      // One sense, two learner languages, two glosses (D1).
      { lemma: 'חלון', lang: 'en', key: 'window', alternatives: [], members: ['s_window'] },
      { lemma: 'חלון', lang: 'ru', key: 'окно', alternatives: [], members: ['s_window'] },
    ]);

    const counts = await db.execute<{ rendered: number; memberships: number }>(sql`
      select (select count(distinct (sense_id, user_language_code)) from dict_var_translations)::int as rendered,
             (select count(*) from dict_sense_glosses)::int as memberships`);
    expect(counts.rows[0].memberships).toBe(counts.rows[0].rendered);
  });

  it("cleans lane 0's translation shapes exactly as splitTranslation does", async () => {
    const db = await emptyDatabase();
    await runMigrationsFrom(db, migrationsUpTo('0021_enrollment_grants'));
    await db.execute(sql`
      insert into dict_lexemes (id, language_code, lemma, part_of_speech) values ('l_shapes', 'en', 'shapes', 'noun');
      insert into dict_variants (id, lexeme_id, language_code, form, kind, entry_rank)
        values ('v_shapes', 'l_shapes', 'en', 'shapes', 'word', 0);
    `);
    for (const [rank, shape] of TRANSLATION_SHAPES.entries()) {
      await db.execute(sql`insert into dict_senses (id, lexeme_id, sense_code) values (${`s${rank}`}, 'l_shapes', ${`code_${rank}`})`);
      await db.execute(sql`insert into dict_var_translations (variant_id, sense_id, user_language_code, translation, rank)
        values ('v_shapes', ${`s${rank}`}, 'he', ${shape}, ${rank})`);
    }

    await runMigrations(db);

    const rows = await db.execute<{ sense_id: string; translation: string; alternatives: string[] }>(
      sql`select sense_id, translation, alternatives from dict_var_translations where variant_id = 'v_shapes'`,
    );
    for (const [rank, shape] of TRANSLATION_SHAPES.entries()) {
      const row = rows.rows.find((r) => r.sense_id === `s${rank}`)!;
      expect({ shape, translation: row.translation, alternatives: row.alternatives }).toEqual({ shape, ...splitTranslation(shape) });
    }
  });
});
