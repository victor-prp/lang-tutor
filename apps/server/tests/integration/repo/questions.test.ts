import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';
import { content, optionsFor } from '../../../src/db/content';
import { createQuestionRepo } from '../../../src/repo/questions';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
});

afterEach(async () => {
  await t.close();
});

describe('loadQuestionPool', () => {
  it('returns every shared question for the language pair', async () => {
    await withTx(t.db, async (tx) => {
      const pool = await createQuestionRepo(tx).loadQuestionPool('en', 'he', 'u_1');
      expect(pool).toHaveLength(content.length);
    });
  });

  it('returns options in canonical order with correct_option pointing at the right one', async () => {
    await withTx(t.db, async (tx) => {
      const pool = await createQuestionRepo(tx).loadQuestionPool('en', 'he', 'u_1');
      const entry = content.find((row) => row.question_id === 'q-window')!;
      const question = pool.find((q) => q.id === 'q-window')!;
      expect(question.options).toEqual(optionsFor(entry).map((option) => option.text));
      expect(question.correct_option).toBe(entry.correct_option);
    });
  });

  it("uses the term variant's form as the prompt, not the lemma", async () => {
    await withTx(t.db, async (tx) => {
      const pool = await createQuestionRepo(tx).loadQuestionPool('en', 'he', 'u_1');
      expect(pool.find((q) => q.id === 'q-remember')!.question).toBe('to remember');
    });
  });

  it('exposes the vocabulary term id, which the database issues', async () => {
    await withTx(t.db, async (tx) => {
      const pool = await createQuestionRepo(tx).loadQuestionPool('en', 'he', 'u_1');
      // Server-issued since phase 10 — no layer generates randomness, so the
      // authored `vt-en-window` is gone.
      expect(pool.find((q) => q.id === 'q-window')!.vocab_term_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  it('returns nothing for a language pair with no content', async () => {
    await withTx(t.db, async (tx) => {
      expect(await createQuestionRepo(tx).loadQuestionPool('es', 'ru', 'u_1')).toEqual([]);
    });
  });
});
