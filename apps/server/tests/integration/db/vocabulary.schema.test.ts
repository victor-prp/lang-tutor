import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { insertLexeme } from '../../support/dictRows';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';

let t: TestDb;
let kite: { lexemeId: string; variantIds: string[]; senseIds: string[] };

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1'); // enrolled in English as e_u_1
  kite = await insertLexeme(t.db, {
    lemma: 'kite',
    languageCode: 'en',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'toy' }],
    variants: [
      {
        form: 'kite',
        kind: 'word',
        entryRank: 0,
        translations: [
          { senseCode: 'toy', rank: 0, translation: 'עפיפון', exampleSource: null, exampleTarget: null },
        ],
      },
    ],
  });
});
afterEach(async () => {
  await t.close();
});

type Column = 'enrollment' | 'sense' | 'lexeme' | 'lemma' | 'variant';
const insert = (over: Partial<Record<Column, string>> = {}) =>
  t.db.execute(sql`
    insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, lemma, variant_id)
    values (${over.enrollment ?? enrollmentOf('u_1')}, ${over.sense ?? kite.senseIds[0]},
            ${over.lexeme ?? kite.lexemeId}, ${over.lemma ?? 'kite'}, ${over.variant ?? kite.variantIds[0]})`);

const violating = (constraint: string) =>
  expect.objectContaining({
    cause: expect.objectContaining({ message: expect.stringContaining(constraint) }),
  });

describe('vocabulary_entries', () => {
  it('accepts an entry and stamps created_at', async () => {
    await insert();
    const rows = await t.db.execute<{ created_at: string }>(
      sql`select created_at from vocabulary_entries`,
    );
    expect(rows.rows).toHaveLength(1);
    // Raw db.execute() returns timestamps as Postgres text format. Verify the value
    // is a valid timestamp close to now (within 60 seconds).
    const createdAt = rows.rows[0].created_at;
    expect(createdAt).toBeTruthy();
    const parsedTime = Date.parse(createdAt);
    expect(parsedTime).not.toBeNaN();
    expect(Math.abs(parsedTime - Date.now())).toBeLessThan(60_000);
  });

  it('holds one entry per (enrollment, sense) — the research decision as a constraint', async () => {
    await insert();
    await expect(insert()).rejects.toThrow(violating('vocabulary_entries_pkey'));
  });

  it.each<[Column, string]>([
    ['enrollment', 'vocabulary_entries_enrollment_fk'],
    ['sense', 'vocabulary_entries_sense_fk'],
    ['lexeme', 'vocabulary_entries_lexeme_lemma_fk'],
    ['lemma', 'vocabulary_entries_lexeme_lemma_fk'],
    ['variant', 'vocabulary_entries_variant_fk'],
  ])('rejects an unknown %s', async (column, constraint) => {
    await expect(insert({ [column]: 'nope' })).rejects.toThrow(violating(constraint));
  });

  it("rejects a lemma that is not its lexeme's, even one another lexeme has", async () => {
    await insertLexeme(t.db, {
      lemma: 'fly',
      languageCode: 'en',
      partOfSpeech: 'verb',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'move' }],
      variants: [],
    });
    await expect(insert({ lemma: 'fly' })).rejects.toThrow(violating('vocabulary_entries_lexeme_lemma_fk'));
  });

  it('requires a lemma', async () => {
    await expect(
      t.db.execute(sql`
        insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, variant_id)
        values (${enrollmentOf('u_1')}, ${kite.senseIds[0]}, ${kite.lexemeId}, ${kite.variantIds[0]})`),
    ).rejects.toThrow(expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringContaining('lemma') }) }));
  });

  it('is wiped with the dictionary by TRUNCATE ... CASCADE, as db:reseed does', async () => {
    await insert();
    await t.db.execute(sql`truncate dict_lexemes cascade`);
    const rows = await t.db.execute(sql`select 1 from vocabulary_entries`);
    expect(rows.rows).toHaveLength(0);
  });

  it('carries exactly the two indexes the spec names, and no single-column FK index', async () => {
    const rows = await t.db.execute<{ indexname: string; indexdef: string }>(sql`
      select indexname, indexdef from pg_indexes where tablename = 'vocabulary_entries'
      order by indexname`);
    expect(rows.rows.map((r) => r.indexname)).toEqual([
      'vocabulary_entries_enrollment_lemma_idx',
      'vocabulary_entries_pkey',
    ]);
    expect(rows.rows[0].indexdef).toContain('(enrollment_id, lemma, created_at)');
  });

  it('indexes dict_var_translations by sense and language', async () => {
    const rows = await t.db.execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes
      where indexname = 'dict_var_translations_sense_language_idx'`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].indexdef).toContain('(sense_id, user_language_code)');
  });
});
