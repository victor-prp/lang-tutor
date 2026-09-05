import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';
import { content } from '../../../src/db/content';
import { users } from '../../../src/db/schema';
import { createQuestionRepo } from '../../../src/repo/questions';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  await t.db.insert(users).values({ id: 'u1' });
});

afterEach(async () => {
  await t.close();
});

describe('loadQuestionPool', () => {
  it('returns every shared question for the language pair', async () => {
    await withTx(t.db, async (tx) => {
      const pool = await createQuestionRepo(tx).loadQuestionPool('en', 'he', 'u1');
      expect(pool).toHaveLength(content.length);
    });
  });

  it('returns options in canonical order with correct_option pointing at the right one', async () => {
    await withTx(t.db, async (tx) => {
      const pool = await createQuestionRepo(tx).loadQuestionPool('en', 'he', 'u1');
      const question = pool.find((q) => q.id === 'q-window')!;
      expect(question.options).toEqual(['דלת', 'חלון', 'שולחן', 'קיר']);
      expect(question.correct_option).toBe(1);
    });
  });

  it("uses the term variant's form as the prompt, not the lemma", async () => {
    await withTx(t.db, async (tx) => {
      const pool = await createQuestionRepo(tx).loadQuestionPool('en', 'he', 'u1');
      expect(pool.find((q) => q.id === 'q-remember')!.question).toBe('to remember');
    });
  });

  it('exposes the vocabulary term id', async () => {
    await withTx(t.db, async (tx) => {
      const pool = await createQuestionRepo(tx).loadQuestionPool('en', 'he', 'u1');
      expect(pool.find((q) => q.id === 'q-window')!.vocab_term_id).toBe('vt-en-window');
    });
  });

  it('returns nothing for a language pair with no content', async () => {
    await withTx(t.db, async (tx) => {
      expect(await createQuestionRepo(tx).loadQuestionPool('es', 'ru', 'u1')).toEqual([]);
    });
  });
});
