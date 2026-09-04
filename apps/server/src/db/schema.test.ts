import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { eq } from 'drizzle-orm';

import { createDb, type Db } from './client';
import { runMigrations } from './migrate';
import { sessions, users } from './schema';

const ADMIN_URL = 'postgres://postgres:postgres@localhost:5432/postgres';
const DB_NAME = 'lang_tutor_schema_test';

let admin: ReturnType<typeof createDb>;
let handle: ReturnType<typeof createDb>;
let db: Db;

beforeAll(async () => {
  admin = createDb(ADMIN_URL, 1);
  await admin.db.execute(sql.raw(`drop database if exists ${DB_NAME} with (force)`));
  await admin.db.execute(sql.raw(`create database ${DB_NAME}`));
  handle = createDb(`postgres://postgres:postgres@localhost:5432/${DB_NAME}`);
  db = handle.db;
  await runMigrations(db);
}, 60_000);

afterAll(async () => {
  await handle.close();
  await admin.db.execute(sql.raw(`drop database if exists ${DB_NAME} with (force)`));
  await admin.close();
});

const TABLES = [
  'users',
  'vocab_terms',
  'term_variants',
  'vocab_term_senses',
  'term_sense_translations',
  'questions',
  'sessions',
  'session_questions',
  'answers',
];

// A minimal valid content chain, so the questions tests have something to hang off.
async function seedOneTerm(db: Db): Promise<void> {
  await db.execute(sql`
    insert into vocab_terms (id, language_code, lemma) values ('vt-en-window', 'en', 'window');
    insert into term_variants (id, term_id, form, kind)
      values ('tv-en-window-base', 'vt-en-window', 'window', 'base');
    insert into vocab_term_senses (id, term_id, sense_code)
      values ('sense-window-default', 'vt-en-window', 'default');
    insert into term_sense_translations (sense_id, user_language_code, translation)
      values ('sense-window-default', 'he', 'חלון');
  `);
}

function optionsOf(overrides: unknown): string {
  return JSON.stringify(overrides);
}

async function insertQuestion(db: Db, id: string, options: unknown): Promise<unknown> {
  return db.execute(sql`
    insert into questions (id, user_id, sense_id, prompt_variant_id,
                           target_language, user_language_code, type, options)
    values (${id}, null, 'sense-window-default', 'tv-en-window-base',
            'en', 'he', 'multiple_choice', ${sql.raw(`'${optionsOf(options)}'::jsonb`)})
  `);
}

const VALID_OPTIONS = [
  { position: 0, text: 'דלת', is_correct: false },
  { position: 1, text: 'חלון', is_correct: true },
  { position: 2, text: 'שולחן', is_correct: false },
  { position: 3, text: 'קיר', is_correct: false },
];

describe('the migrated schema', () => {
  it('creates all nine tables', async () => {
    const result = await db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables where table_schema = 'public'
    `);
    const names = result.rows.map((r) => r.table_name);
    for (const table of TABLES) expect(names).toContain(table);
  });

  it('defaults a user to Hebrew/English', async () => {
    await db.insert(users).values({ id: 'u-defaults' });
    const [row] = await db.select().from(users).where(eq(users.id, 'u-defaults'));
    expect(row.nativeLanguage).toBe('he');
    expect(row.targetLanguage).toBe('en');
  });

  it('accepts a well-formed options array', async () => {
    await seedOneTerm(db);
    await expect(insertQuestion(db, 'q-ok', VALID_OPTIONS)).resolves.toBeDefined();
  });

  it('rejects two correct options', async () => {
    const twoCorrect = VALID_OPTIONS.map((o, i) => ({ ...o, is_correct: i < 2 }));
    await expect(insertQuestion(db, 'q-two-correct', twoCorrect)).rejects.toThrow(
      expect.objectContaining({
        cause: expect.objectContaining({ message: expect.stringContaining('questions_options_valid') }),
      }),
    );
  });

  it('rejects zero correct options', async () => {
    const noneCorrect = VALID_OPTIONS.map((o) => ({ ...o, is_correct: false }));
    await expect(insertQuestion(db, 'q-none-correct', noneCorrect)).rejects.toThrow(
      expect.objectContaining({
        cause: expect.objectContaining({ message: expect.stringContaining('questions_options_valid') }),
      }),
    );
  });

  it('rejects duplicate option texts', async () => {
    const duplicated = [...VALID_OPTIONS];
    duplicated[2] = { position: 2, text: 'דלת', is_correct: false };
    await expect(insertQuestion(db, 'q-dup-text', duplicated)).rejects.toThrow(
      expect.objectContaining({
        cause: expect.objectContaining({ message: expect.stringContaining('questions_options_valid') }),
      }),
    );
  });

  it('rejects a gap in option positions', async () => {
    const gapped = VALID_OPTIONS.map((o, i) => ({ ...o, position: i === 3 ? 7 : o.position }));
    await expect(insertQuestion(db, 'q-gap', gapped)).rejects.toThrow(
      expect.objectContaining({
        cause: expect.objectContaining({ message: expect.stringContaining('questions_options_valid') }),
      }),
    );
  });

  it('rejects an answer naming a question that is not in the session at that position', async () => {
    await db.insert(users).values({ id: 'u-fk' });
    const [session] = await db.insert(sessions).values({ userId: 'u-fk' }).returning();
    await db.execute(sql`
      insert into session_questions (session_id, position, question_id, option_order)
      values (${session.id}, 0, 'q-ok', '{0,1,2,3}')
    `);
    await expect(
      db.execute(sql`
        insert into answers (session_id, position, question_id, selected_option_position)
        values (${session.id}, 0, 'q-two-correct', 1)
      `),
    ).rejects.toThrow();
  });

  it('rejects a second answer at the same position', async () => {
    const [session] = await db.insert(sessions).values({ userId: 'u-fk' }).returning();
    await db.execute(sql`
      insert into session_questions (session_id, position, question_id, option_order)
      values (${session.id}, 0, 'q-ok', '{0,1,2,3}')
    `);
    const insertAnswer = () =>
      db.execute(sql`
        insert into answers (session_id, position, question_id, selected_option_position)
        values (${session.id}, 0, 'q-ok', 1)
      `);
    await insertAnswer();
    await expect(insertAnswer()).rejects.toThrow();
  });
});
