import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { DIMENSIONS } from '@lang-tutor/core/domain';
import { sql } from 'drizzle-orm';

import { insertLexeme } from '../../support/dictRows';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';

let t: TestDb;
let glossId: string;
let lexemeId: string;
const E = enrollmentOf('u_1');

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  const kite = await insertLexeme(t.db, {
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
  glossId = kite.glossIds[0];
  lexemeId = kite.lexemeId;
  // Directly, without progress rows: these tests write those rows themselves.
  await t.db.execute(sql`
    insert into vocabulary_entries (enrollment_id, gloss_id, lexeme_id, lemma, variant_id, added_by_user_id)
    values (${E}, ${glossId}, ${kite.lexemeId}, (select lemma from dict_lexemes where id = ${kite.lexemeId}),
            ${kite.variantIds[0]}, 'u_1')`);
});
afterEach(async () => {
  await t.close();
});

const violating = (constraint: string) =>
  expect.objectContaining({
    cause: expect.objectContaining({ message: expect.stringContaining(constraint) }),
  });

const progress = (over: { gloss?: string; dimension?: string; level?: number } = {}) =>
  t.db.execute(sql`
    insert into gloss_progress (enrollment_id, gloss_id, dimension, level)
    values (${E}, ${over.gloss ?? glossId}, ${over.dimension ?? 'written_receptive'}, ${over.level ?? 1})`);

describe('gloss_progress', () => {
  it('takes one row per dimension and starts each at level 1 with no dates', async () => {
    for (const dimension of DIMENSIONS) {
      await t.db.execute(sql`
        insert into gloss_progress (enrollment_id, gloss_id, dimension) values (${E}, ${glossId}, ${dimension})`);
    }
    const rows = await t.db.execute<{ level: number; last_step_on: string | null; last_wrong_on: string | null }>(
      sql`select level, last_step_on, last_wrong_on from gloss_progress`,
    );
    expect(rows.rows).toHaveLength(5);
    expect(rows.rows.every((r) => r.level === 1 && r.last_step_on === null && r.last_wrong_on === null)).toBe(true);
  });

  it('holds one row per (enrollment, gloss, dimension)', async () => {
    await progress();
    await expect(progress()).rejects.toThrow(violating('gloss_progress_pkey'));
  });

  it('refuses a dimension it does not know', async () => {
    await expect(progress({ dimension: 'reading' })).rejects.toThrow(violating('gloss_progress_dimension_known'));
  });

  it.each([0, 6])('refuses level %i', async (level) => {
    await expect(progress({ level })).rejects.toThrow(violating('gloss_progress_level_range'));
  });

  it('refuses a row for a gloss that is not saved', async () => {
    await expect(progress({ gloss: 'not-saved' })).rejects.toThrow(violating('gloss_progress_entry_fk'));
  });

  it('goes with the entry when the gloss is unsaved', async () => {
    await progress();
    await t.db.execute(sql`delete from vocabulary_entries where enrollment_id = ${E} and gloss_id = ${glossId}`);
    const rows = await t.db.execute(sql`select 1 from gloss_progress`);
    expect(rows.rows).toHaveLength(0);
  });

  // Phase 31 (ON UPDATE CASCADE): a merge moves an entry to its survivor gloss,
  // and its rows follow it.
  it('follows its entry to another gloss of the lexeme', async () => {
    await progress();
    await progress({ dimension: 'spelling' });
    await t.db.execute(sql`
      insert into dict_glosses (id, lexeme_id, user_language_code, key) values ('g-survivor', ${lexemeId}, 'he', 'survivor')`);
    await t.db.execute(sql`update vocabulary_entries set gloss_id = 'g-survivor' where enrollment_id = ${E} and gloss_id = ${glossId}`);
    const rows = await t.db.execute<{ gloss_id: string }>(sql`select gloss_id from gloss_progress`);
    expect(rows.rows).toEqual([{ gloss_id: 'g-survivor' }, { gloss_id: 'g-survivor' }]);
  });
});

describe('session_progress', () => {
  async function session(): Promise<string> {
    const rows = await t.db.execute<{ id: string }>(sql`
      insert into sessions (user_id, enrollment_id, status, source)
      values ('u_1', ${E}, 'skipped', 'seed') returning id`);
    return rows.rows[0].id;
  }
  const snapshot = (sessionId: string, over: { dimension?: string; before?: number; after?: number } = {}) =>
    t.db.execute(sql`
      insert into session_progress (session_id, gloss_id, dimension, level_before, level_after)
      values (${sessionId}, ${glossId}, ${over.dimension ?? 'written_receptive'}, ${over.before ?? 1}, ${over.after ?? 2})`);

  it('records a level that rose or stayed', async () => {
    const id = await session();
    await snapshot(id);
    await snapshot(id, { dimension: 'spelling', before: 1, after: 1 });
    const rows = await t.db.execute(sql`select 1 from session_progress`);
    expect(rows.rows).toHaveLength(2);
  });

  it('refuses a level that went down', async () => {
    const id = await session();
    await expect(snapshot(id, { before: 3, after: 2 })).rejects.toThrow(violating('session_progress_levels_valid'));
  });

  it('refuses a dimension it does not know', async () => {
    const id = await session();
    await expect(snapshot(id, { dimension: 'reading' })).rejects.toThrow(
      violating('session_progress_dimension_known'),
    );
  });

  it('goes with its session', async () => {
    const id = await session();
    await snapshot(id);
    await t.db.execute(sql`delete from sessions where id = ${id}`);
    const rows = await t.db.execute(sql`select 1 from session_progress`);
    expect(rows.rows).toHaveLength(0);
  });
});
