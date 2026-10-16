import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createMemoryRepo } from '../../../src/repo/memory';
import { insertLexeme } from '../../support/dictRows';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;
const E = enrollmentOf('u_1');
let kite: { lexemeId: string; variantIds: string[]; glossIds: string[] };

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  kite = await insertLexeme(t.db, {
    lemma: 'kite',
    languageCode: 'en',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'toy' }, { senseCode: 'bird' }, { senseCode: 'cheque' }],
    variants: [
      {
        form: 'kite',
        kind: 'word',
        entryRank: 0,
        translations: [
          { senseCode: 'toy', rank: 0, translation: 'עפיפון', exampleSource: null, exampleTarget: null },
          { senseCode: 'bird', rank: 1, translation: 'דיה', exampleSource: null, exampleTarget: null },
          { senseCode: 'cheque', rank: 2, translation: 'צ׳ק', exampleSource: null, exampleTarget: null },
        ],
      },
    ],
  });
  for (const glossId of kite.glossIds) {
    await t.db.execute(sql`
      insert into vocabulary_entries (enrollment_id, gloss_id, lexeme_id, lemma, variant_id, added_by_user_id)
      values (${E}, ${glossId}, ${kite.lexemeId}, 'kite', ${kite.variantIds[0]}, 'u_1')`);
  }
});
afterEach(async () => {
  await t.close();
});

async function practise(glossId: string, day: string) {
  await t.db.execute(sql`
    insert into gloss_memory (enrollment_id, gloss_id, dimension, stability, difficulty, last_day, reps, lapses, params)
    values (${E}, ${glossId}, 'written_receptive', 1, 5, ${day}::date, 1, 0, 'p')`);
}

const meaningOf = async (glossId: string) =>
  (await t.db.execute<{ key: string }>(sql`select key from dict_glosses where id = ${glossId}`)).rows[0].key;

describe('findPractisedWords (phase 59 D1)', () => {
  it('lists the practised words only, most recently reviewed first, at most limit', async () => {
    await practise(kite.glossIds[0], '2026-10-01');
    await practise(kite.glossIds[1], '2026-10-05');
    const words = await withTx(t.db, (tx) => createMemoryRepo(tx).findPractisedWords({ enrollmentId: E, limit: 200 }));
    expect(words).toEqual([
      { glossId: kite.glossIds[1], word: 'kite', meaning: await meaningOf(kite.glossIds[1]) },
      { glossId: kite.glossIds[0], word: 'kite', meaning: await meaningOf(kite.glossIds[0]) },
    ]);
    const one = await withTx(t.db, (tx) => createMemoryRepo(tx).findPractisedWords({ enrollmentId: E, limit: 1 }));
    expect(one.map((word) => word.glossId)).toEqual([kite.glossIds[1]]);
  });
});
