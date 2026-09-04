import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { createTestDb, type TestDb } from '../../tests/support/testDb';
import { content } from './content';
import { seedContent } from './seed';
import { questions, termSenseTranslations, termVariants, vocabTerms, vocabTermSenses } from './schema';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

describe('seedContent', () => {
  // The template already ran seedContent via globalSetup, so a clone arrives
  // seeded. That is exactly what the rest of the suite depends on.
  it('leaves the clone with one row per content entry in each shared layer', async () => {
    expect(await t.db.select().from(vocabTerms)).toHaveLength(content.length);
    expect(await t.db.select().from(termVariants)).toHaveLength(content.length);
    expect(await t.db.select().from(vocabTermSenses)).toHaveLength(content.length);
    expect(await t.db.select().from(termSenseTranslations)).toHaveLength(content.length);
    expect(await t.db.select().from(questions)).toHaveLength(content.length);
  });

  it('is idempotent — a second run inserts nothing', async () => {
    await seedContent(t.db);
    expect(await t.db.select().from(vocabTerms)).toHaveLength(content.length);
    expect(await t.db.select().from(questions)).toHaveLength(content.length);
  });

  it('marks every seeded question shared and Hebrew/English', async () => {
    for (const row of await t.db.select().from(questions)) {
      expect(row.userId).toBeNull();
      expect(row.targetLanguage).toBe('en');
      expect(row.userLanguageCode).toBe('he');
      expect(row.type).toBe('multiple_choice');
    }
  });

  it('stores options in canonical order with exactly one correct', async () => {
    const [row] = await t.db.select().from(questions).where(eq(questions.id, 'q-window'));
    expect(row.options).toEqual([
      { position: 0, text: 'דלת', is_correct: false },
      { position: 1, text: 'חלון', is_correct: true },
      { position: 2, text: 'שולחן', is_correct: false },
      { position: 3, text: 'קיר', is_correct: false },
    ]);
  });

  it("points q-remember's prompt at the infinitive variant, not the lemma", async () => {
    const [term] = await t.db.select().from(vocabTerms).where(eq(vocabTerms.id, 'vt-en-remember'));
    expect(term.lemma).toBe('remember');

    const [question] = await t.db.select().from(questions).where(eq(questions.id, 'q-remember'));
    const [variant] = await t.db
      .select()
      .from(termVariants)
      .where(eq(termVariants.id, question.promptVariantId));
    expect(variant.form).toBe('to remember');
    expect(variant.kind).toBe('infinitive');
  });
});
