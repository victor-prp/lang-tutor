import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createPronunciationRepo } from '../../../src/repo/pronunciationScores';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

const repo = <T>(fn: (r: ReturnType<typeof createPronunciationRepo>) => Promise<T>) =>
  withTx(t.db, (tx) => fn(createPronunciationRepo(tx)));

describe('pronunciation scores (phase 50 D3)', () => {
  it('finds the stored score of each pair asked, in its language only', async () => {
    await repo((r) =>
      r.insert('en', [
        { a: 'cell', b: 'sell', score: 1 },
        { a: 'sheep', b: 'ship', score: 0.8 },
      ]),
    );
    await repo((r) => r.insert('it', [{ a: 'cell', b: 'sell', score: 0.2 }]));

    const found = await repo((r) =>
      r.find('en', [
        { a: 'cell', b: 'sell' },
        { a: 'sheep', b: 'ship' },
        { a: 'bad', b: 'bat' },
      ]),
    );
    expect(found).toHaveLength(2);
    expect(found).toEqual(expect.arrayContaining([{ a: 'cell', b: 'sell', score: 1 }, { a: 'sheep', b: 'ship', score: 0.8 }]));
  });

  it('reads a score back as it was written', async () => {
    await repo((r) => r.insert('ru', [{ a: 'луг', b: 'лук', score: 0.95 }]));
    expect(await repo((r) => r.find('ru', [{ a: 'луг', b: 'лук' }]))).toEqual([{ a: 'луг', b: 'лук', score: 0.95 }]);
  });

  it('keeps the first score when a pair is written twice', async () => {
    await repo((r) => r.insert('en', [{ a: 'cell', b: 'sell', score: 1 }]));
    await repo((r) => r.insert('en', [{ a: 'cell', b: 'sell', score: 0.3 }]));
    expect(await repo((r) => r.find('en', [{ a: 'cell', b: 'sell' }]))).toEqual([{ a: 'cell', b: 'sell', score: 1 }]);
  });

  it('asks nothing for no pairs and writes nothing for no rows', async () => {
    expect(await repo((r) => r.find('en', []))).toEqual([]);
    await repo((r) => r.insert('en', []));
    const { rows } = await t.db.execute<{ n: number }>(sql`select count(*)::int as n from pronunciation_scores`);
    expect(rows[0].n).toBe(0);
  });

  it('refuses a pair out of order and a score outside 0 to 1', async () => {
    await expect(repo((r) => r.insert('en', [{ a: 'sell', b: 'cell', score: 1 }]))).rejects.toThrow(
      expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringContaining('pronunciation_scores_ordered') }) }),
    );
    await expect(repo((r) => r.insert('en', [{ a: 'cell', b: 'sell', score: 1.5 }]))).rejects.toThrow(
      expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringContaining('pronunciation_scores_score_range') }) }),
    );
  });

  it('orders by code point, whatever the database collation, as orderedPair does', async () => {
    // A collation that ignores case would put "Zebra" after "apple"; code
    // points put it first. The server lowercases, but the check must agree
    // with JavaScript's `<` on every pair it can send.
    expect('Zebra' < 'apple').toBe(true);
    await expect(repo((r) => r.insert('en', [{ a: 'Zebra', b: 'apple', score: 0 }]))).resolves.toBeUndefined();
  });
});
