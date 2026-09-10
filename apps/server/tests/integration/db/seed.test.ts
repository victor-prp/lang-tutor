import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { content, correctAnswerFor, optionsFor } from '../../../src/db/content';
import { recorded } from '../../../src/db/content.generated';
import { questions, termVariants, vocabTerms, vocabTermSenses } from '../../../src/db/schema';
import { flattenEntries, mergeEntries, rowsToSenses } from '../../../src/domain/vocabulary';
import { seedContent } from '../../../src/db/seed';
import { createVocabRepo } from '../../../src/repo/vocabulary';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

// The template already ran seedContent via globalSetup, so a clone arrives
// seeded. That is exactly what the rest of the suite depends on.
describe('seedContent', () => {
  it('leaves every recorded string servable, as exactly the merge persistEntries produces', async () => {
    // This is where "the seed is a recording" is actually verified: the rows
    // the seed produced are the rows persistEntries produces, rather than a
    // shape authored twice.
    await withTx(t.db, async (tx) => {
      const vocab = createVocabRepo(tx);
      for (const entry of content) {
        const rows = await vocab.findSensesByForm({
          form: entry.query,
          languageCode: 'en',
          userLanguageCode: 'he',
        });
        expect(rowsToSenses(rows)).toEqual(
          flattenEntries(mergeEntries(recorded[entry.query].entries)),
        );
      }
    });
  });

  it('writes one question per content entry, and one term per distinct lemma', async () => {
    expect(await t.db.select().from(questions)).toHaveLength(content.length);

    const lemmas = new Set(
      content.flatMap((entry) => recorded[entry.query].entries.map((e) => e.lemma)),
    );
    expect(await t.db.select().from(vocabTerms)).toHaveLength(lemmas.size);
  });

  it('gives every variant its language and its entry rank', async () => {
    for (const variant of await t.db.select().from(termVariants)) {
      expect(variant.languageCode).toBe('en');
      expect(variant.entryRank).toBeGreaterThanOrEqual(0);
      expect(['word', 'phrase', 'sentence']).toContain(variant.kind);
    }
  });

  it('ranks every sense from zero and keeps the recorded part of speech and example', async () => {
    const [entry] = content;
    const [term] = await t.db
      .select()
      .from(vocabTerms)
      .where(eq(vocabTerms.lemma, recorded[entry.query].entries[0].lemma));
    const senses = await t.db
      .select()
      .from(vocabTermSenses)
      .where(eq(vocabTermSenses.termId, term.id));

    const recordedSenses = recorded[entry.query].entries[0].senses;
    expect(senses.map((sense) => sense.rank).sort()).toEqual(
      recordedSenses.map((_, rank) => rank),
    );
    const first = senses.find((sense) => sense.rank === 0)!;
    expect(first.senseCode).toBe(recordedSenses[0].sense_code);
    expect(first.partOfSpeech).toBe(recordedSenses[0].part_of_speech ?? null);
    expect(first.exampleSource).toBe(recordedSenses[0].example?.source ?? null);
  });

  it('points every question at the sense and variant its own recording wrote', async () => {
    for (const entry of content) {
      const [question] = await t.db
        .select()
        .from(questions)
        .where(eq(questions.id, entry.question_id));
      const [variant] = await t.db
        .select()
        .from(termVariants)
        .where(eq(termVariants.id, question.promptVariantId));
      const [sense] = await t.db
        .select()
        .from(vocabTermSenses)
        .where(eq(vocabTermSenses.id, question.senseId));

      expect(variant.form).toBe(entry.query);
      expect(sense.termId).toBe(variant.termId);
      expect(sense.rank).toBe(0);
    }
  });

  it('makes the correct option the recorded sense translation', async () => {
    for (const entry of content) {
      const [question] = await t.db
        .select()
        .from(questions)
        .where(eq(questions.id, entry.question_id));
      expect(question.options).toEqual(optionsFor(entry));
      expect(question.options.find((option) => option.is_correct)!.text).toBe(
        correctAnswerFor(entry),
      );
    }
  });

  it('marks every seeded question shared and Hebrew/English', async () => {
    for (const row of await t.db.select().from(questions)) {
      expect(row.userId).toBeNull();
      expect(row.targetLanguage).toBe('en');
      expect(row.userLanguageCode).toBe('he');
      expect(row.type).toBe('multiple_choice');
    }
  });

  it('is idempotent — a second run inserts nothing', async () => {
    const before = {
      terms: (await t.db.select().from(vocabTerms)).length,
      variants: (await t.db.select().from(termVariants)).length,
      senses: (await t.db.select().from(vocabTermSenses)).length,
      questions: (await t.db.select().from(questions)).length,
    };

    await seedContent(t.db);

    expect({
      terms: (await t.db.select().from(vocabTerms)).length,
      variants: (await t.db.select().from(termVariants)).length,
      senses: (await t.db.select().from(vocabTermSenses)).length,
      questions: (await t.db.select().from(questions)).length,
    }).toEqual(before);
  });

  it("stores to remember as the queried form, under the lemma the model gave it", async () => {
    const [variant] = await t.db
      .select()
      .from(termVariants)
      .where(eq(termVariants.form, 'to remember'));
    const [term] = await t.db.select().from(vocabTerms).where(eq(vocabTerms.id, variant.termId));

    expect(term.lemma).toBe(recorded['to remember'].entries[0].lemma);
    expect(term.lemma).not.toBe('to remember');
  });
});
