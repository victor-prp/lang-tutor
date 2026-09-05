import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createTestDb, type TestDb } from '../../tests/support/testDb';
import { content } from '../db/content';
import { users } from '../db/schema';
import { createQuestionRepo } from './questions';

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
    const repo = createQuestionRepo(t.db);
    const pool = await repo.loadQuestionPool('en', 'he', 'u1');
    expect(pool).toHaveLength(content.length);
  });

  it('returns options in canonical order with correct_option pointing at the right one', async () => {
    const repo = createQuestionRepo(t.db);
    const pool = await repo.loadQuestionPool('en', 'he', 'u1');
    const question = pool.find((q) => q.id === 'q-window')!;
    expect(question.options).toEqual(['דלת', 'חלון', 'שולחן', 'קיר']);
    expect(question.correct_option).toBe(1);
  });

  it("uses the term variant's form as the prompt, not the lemma", async () => {
    const repo = createQuestionRepo(t.db);
    const pool = await repo.loadQuestionPool('en', 'he', 'u1');
    expect(pool.find((q) => q.id === 'q-remember')!.question).toBe('to remember');
  });

  it('exposes the vocabulary term id', async () => {
    const repo = createQuestionRepo(t.db);
    const pool = await repo.loadQuestionPool('en', 'he', 'u1');
    expect(pool.find((q) => q.id === 'q-window')!.vocab_term_id).toBe('vt-en-window');
  });

  it('returns nothing for a language pair with no content', async () => {
    const repo = createQuestionRepo(t.db);
    expect(await repo.loadQuestionPool('es', 'ru', 'u1')).toEqual([]);
  });
});
