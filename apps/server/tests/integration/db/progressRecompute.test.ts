import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { recomputeProgress } from '../../../src/db/progressRecompute';
import { insertLexeme } from '../../support/dictRows';
import {
  insertAnsweredSession,
  insertProgressRows,
  readProgress,
  readSnapshot,
  setLevel,
} from '../../support/progressRows';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';

let t: TestDb;
const E = enrollmentOf('u_1');
let kite: { lexemeId: string; variantIds: string[]; senseIds: string[] };

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
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

async function savedAt(at: string) {
  await t.db.execute(sql`
    insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, variant_id, created_at)
    values (${E}, ${kite.senseIds[0]}, ${kite.lexemeId}, ${kite.variantIds[0]}, ${at}::timestamptz)`);
  await insertProgressRows(t.db, E, [kite.senseIds[0]]);
}

/** A one-question session about kite, answered once at `at`. */
const session = (status: 'completed' | 'skipped' | 'ready', correct: boolean, at: string) =>
  insertAnsweredSession(t.db, {
    userId: 'u_1',
    enrollmentId: E,
    status,
    asked: [{ senseId: kite.senseIds[0], variantId: kite.variantIds[0], translation: 'עפיפון' }],
    answers: [{ position: 0, correct, at }],
  });

const receptive = async () =>
  (await readProgress(t.db, E)).find((row) => row.dimension === 'written_receptive');

describe('recomputeProgress', () => {
  it('rebuilds levels from ended sessions in the order they ended, and their snapshots', async () => {
    await savedAt('2026-01-01 00:00:00+00');
    const first = await session('completed', true, '2026-01-05 10:00:00+00');
    const second = await session('skipped', true, '2026-01-06 10:00:00+00');
    const third = await session('completed', false, '2026-01-07 10:00:00+00');
    await session('ready', true, '2026-01-20 10:00:00+00'); // open: does not count
    await setLevel(t.db, { enrollmentId: E, senseId: kite.senseIds[0], level: 5 }); // junk to reset

    expect(await recomputeProgress(t.db)).toEqual({ sessions: 3 });

    expect(await receptive()).toMatchObject({ level: 3, lastStepOn: '2026-01-06', lastWrongOn: '2026-01-07' });
    expect(await readSnapshot(t.db, first)).toHaveLength(5);
    expect(await readSnapshot(t.db, second)).toHaveLength(5);
    expect((await readSnapshot(t.db, third)).find((r) => r.dimension === 'written_receptive')).toMatchObject({
      levelBefore: 3,
      levelAfter: 3,
    });
  });

  it('does not count a session that ended before the sense was saved', async () => {
    await savedAt('2026-01-10 00:00:00+00');
    const before = await session('completed', true, '2026-01-05 10:00:00+00');
    await recomputeProgress(t.db);
    expect(await receptive()).toMatchObject({ level: 1, lastStepOn: null });
    expect(await readSnapshot(t.db, before)).toEqual([]);
  });

  it('is idempotent', async () => {
    await savedAt('2026-01-01 00:00:00+00');
    await session('completed', true, '2026-01-05 10:00:00+00');
    await recomputeProgress(t.db);
    const once = await readProgress(t.db, E);
    await recomputeProgress(t.db);
    expect(await readProgress(t.db, E)).toEqual(once);
  });
});
