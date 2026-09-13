import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { and, eq } from 'drizzle-orm';

import { content, correctAnswerFor, optionsFor } from '../../../src/db/content';
import { recorded } from '../../../src/db/content.generated';
import {
  questions,
  dictVarTranslations,
  dictVariants,
  dictLexemes,
  dictSenses,
} from '../../../src/db/schema';
import { flattenEntries, mergeEntries, rowsToSenses } from '../../../src/domain/dictionary';
import { assertSeedable, seedContent } from '../../../src/db/seed';
import { createDictRepo } from '../../../src/repo/dictionary';
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
      const dict = createDictRepo(tx);
      for (const entry of content) {
        const rows = await dict.findSensesByForm({
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
    expect(await t.db.select().from(dictLexemes)).toHaveLength(lemmas.size);
  });

  it('gives every variant its language and its entry rank', async () => {
    for (const variant of await t.db.select().from(dictVariants)) {
      expect(variant.languageCode).toBe('en');
      expect(variant.entryRank).toBeGreaterThanOrEqual(0);
      expect(['word', 'phrase', 'sentence']).toContain(variant.kind);
    }
  });

  it('ranks every sense from zero and keeps the recorded part of speech and example', async () => {
    const [entry] = content;
    const [term] = await t.db
      .select()
      .from(dictLexemes)
      .where(eq(dictLexemes.lemma, recorded[entry.query].entries[0].lemma));
    const senses = await t.db
      .select()
      .from(dictSenses)
      .where(eq(dictSenses.lexemeId, term.id));

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
        .from(dictVariants)
        .where(eq(dictVariants.id, question.promptVariantId));
      const [sense] = await t.db
        .select()
        .from(dictSenses)
        .where(eq(dictSenses.id, question.senseId));

      expect(variant.form).toBe(entry.query);
      expect(sense.lexemeId).toBe(variant.lexemeId);
      expect(sense.rank).toBe(0);
    }
  });

  it("closes the whole class, not just the enumerated case: every question's sense translates to its own correct answer", async () => {
    // content.test.ts only proves the thirteen entry-0 lemmas are distinct — a
    // property of the recordings, not of what a question actually points at.
    // persistEntries is first-writer-wins per term, so if some future
    // recording ever put one lemma at entry 0 of query A and entry 1 of
    // query B, B's question (hung off written[0].senseIds[0], i.e. A's
    // senses) would ask about A's headword while its correct option still
    // came from B's own recording — silently wrong, and invisible to a check
    // that only compares recordings to each other. Checking the row the
    // question actually points at, against the row `optionsFor` actually
    // spliced in, closes that whole class in one assertion instead of the
    // single case content.test.ts enumerates.
    for (const entry of content) {
      const [question] = await t.db
        .select()
        .from(questions)
        .where(eq(questions.id, entry.question_id));
      const [translation] = await t.db
        .select()
        .from(dictVarTranslations)
        .where(
          and(
            eq(dictVarTranslations.senseId, question.senseId),
            eq(dictVarTranslations.userLanguageCode, 'he'),
          ),
        );

      expect(translation.translation).toBe(correctAnswerFor(entry));
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
      terms: (await t.db.select().from(dictLexemes)).length,
      variants: (await t.db.select().from(dictVariants)).length,
      senses: (await t.db.select().from(dictSenses)).length,
      questions: (await t.db.select().from(questions)).length,
    };

    await seedContent(t.db);

    expect({
      terms: (await t.db.select().from(dictLexemes)).length,
      variants: (await t.db.select().from(dictVariants)).length,
      senses: (await t.db.select().from(dictSenses)).length,
      questions: (await t.db.select().from(questions)).length,
    }).toEqual(before);
  });

  it("stores to remember as the queried form, under the lemma the model gave it", async () => {
    const [variant] = await t.db
      .select()
      .from(dictVariants)
      .where(eq(dictVariants.form, 'to remember'));
    const [term] = await t.db.select().from(dictLexemes).where(eq(dictLexemes.id, variant.lexemeId));

    expect(term.lemma).toBe(recorded['to remember'].entries[0].lemma);
    expect(term.lemma).not.toBe('to remember');
  });

  // The primary guard is in tests/eval/generate-content.ts, which refuses to
  // *record* a sentence in the first place — this is the cheap insurance
  // behind it, for a sentence that reached content.generated.ts some other
  // way (a hand edit, or a future recorder that forgets the check).
  it('assertSeedable refuses a recording classified as a sentence, naming the query', () => {
    expect(() => assertSeedable('Where is the station?', 'sentence')).toThrow(
      /Where is the station\?/,
    );
    expect(() => assertSeedable('Where is the station?', 'sentence')).toThrow(/sentence/);
  });

  it('assertSeedable accepts a word or a phrase', () => {
    expect(() => assertSeedable('book', 'word')).not.toThrow();
    expect(() => assertSeedable('excuse me', 'phrase')).not.toThrow();
  });
});
