import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { eq } from 'drizzle-orm';

import { createDb, type Db } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import { sessions, users } from '../../../src/db/schema';
import { ADMIN_URL, urlFor } from '../../support/dbNames';
import { seedUser } from '../../support/seedUser';

const DB_NAME = 'lang_tutor_schema_test';

let admin: ReturnType<typeof createDb>;
let handle: ReturnType<typeof createDb>;
let db: Db;

beforeAll(async () => {
  admin = createDb(ADMIN_URL, { max: 1, onError: () => {} });
  await admin.db.execute(sql.raw(`drop database if exists ${DB_NAME} with (force)`));
  await admin.db.execute(sql.raw(`create database ${DB_NAME}`));
  handle = createDb(urlFor(DB_NAME), { onError: () => {} });
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

// A minimal valid content chain, so the questions tests have something to hang
// off. Phase 10 moved part of speech onto the sense and made language_code,
// entry_rank and rank required.
async function seedOneTerm(db: Db): Promise<void> {
  await db.execute(sql`
    insert into vocab_terms (id, language_code, lemma) values ('vt-en-window', 'en', 'window');
    insert into term_variants (id, term_id, language_code, form, kind, entry_rank)
      values ('tv-en-window-base', 'vt-en-window', 'en', 'window', 'word', 0);
    insert into vocab_term_senses (id, term_id, sense_code, rank, part_of_speech, example_source)
      values ('sense-window-default', 'vt-en-window', 'window_opening', 0, 'noun',
              'I opened the window.');
    insert into term_sense_translations (sense_id, user_language_code, translation, example_target)
      values ('sense-window-default', 'he', 'חלון', 'פתחתי את החלון.');
  `);
}

async function insertQuestion(db: Db, id: string, options: unknown): Promise<unknown> {
  return db.execute(sql`
    insert into questions (id, user_id, sense_id, prompt_variant_id,
                           target_language, user_language_code, type, options)
    values (${id}, null, 'sense-window-default', 'tv-en-window-base',
            'en', 'he', 'multiple_choice', ${JSON.stringify(options)}::jsonb)
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

  // Phase 8 dropped the he/en column defaults: onboarding always supplies the
  // pair, so a default could only mask a bug. The columns are now required.
  it('requires a language pair rather than defaulting one', async () => {
    await expect(
      db.execute(
        sql`insert into users (id, username, display_name, age) values ('u_defaults', 'u_defaults', 'x', 30)`,
      ),
    ).rejects.toThrow();

    await seedUser(db, 'u_defaults');
    const [row] = await db.select().from(users).where(eq(users.id, 'u_defaults'));
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
    await seedUser(db, 'u_fk');
    const [session] = await db.insert(sessions).values({ userId: 'u_fk' }).returning();
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
    const [session] = await db.insert(sessions).values({ userId: 'u_fk' }).returning();
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

  it('issues ids for the vocabulary tables, so no layer generates randomness', async () => {
    await db.execute(
      sql`insert into vocab_terms (language_code, lemma) values ('en', 'defaulted')`,
    );
    const result = await db.execute<{ id: string }>(
      sql`select id from vocab_terms where lemma = 'defaulted'`,
    );
    expect(result.rows[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('refuses two senses of one term at the same rank', async () => {
    await db.execute(sql`
      insert into vocab_terms (id, language_code, lemma) values ('vt-dup', 'en', 'dup');
      insert into vocab_term_senses (term_id, sense_code, rank) values ('vt-dup', 'a', 0);
    `);
    await expect(
      db.execute(sql`insert into vocab_term_senses (term_id, sense_code, rank)
                     values ('vt-dup', 'b', 0)`),
    ).rejects.toThrow();
  });

  it('refuses a negative rank or entry_rank', async () => {
    await expect(
      db.execute(sql`insert into vocab_term_senses (term_id, sense_code, rank)
                     values ('vt-dup', 'c', -1)`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`insert into term_variants (term_id, language_code, form, kind, entry_rank)
                     values ('vt-dup', 'en', 'dup', 'word', -1)`),
    ).rejects.toThrow();
  });

  // The unique index that doubles as the lookup index: one reading of one form,
  // per language, wins. Two different terms and a form that differs only by
  // case, so this also proves lower(form) — not form — is what the index
  // compares.
  it('refuses two term_variants for the same language_code, lower(form) and entry_rank', async () => {
    await db.execute(sql`
      insert into vocab_terms (id, language_code, lemma) values ('vt-idx-a', 'en', 'idx-a');
      insert into vocab_terms (id, language_code, lemma) values ('vt-idx-b', 'en', 'idx-b');
      insert into term_variants (term_id, language_code, form, kind, entry_rank)
        values ('vt-idx-a', 'en', 'Case', 'word', 0);
    `);
    await expect(
      db.execute(sql`insert into term_variants (term_id, language_code, form, kind, entry_rank)
                     values ('vt-idx-b', 'en', 'CASE', 'word', 0)`),
    ).rejects.toThrow(
      expect.objectContaining({
        cause: expect.objectContaining({
          message: expect.stringContaining('term_variants_form_entry_rank_key'),
        }),
      }),
    );
  });

  it('refuses a term_variants insert that omits entry_rank', async () => {
    await db.execute(
      sql`insert into vocab_terms (id, language_code, lemma) values ('vt-no-rank', 'en', 'no-rank')`,
    );
    await expect(
      db.execute(sql`insert into term_variants (term_id, language_code, form, kind)
                     values ('vt-no-rank', 'en', 'no-rank', 'word')`),
    ).rejects.toThrow(
      expect.objectContaining({
        cause: expect.objectContaining({
          message: expect.stringContaining('entry_rank'),
        }),
      }),
    );
  });
});
