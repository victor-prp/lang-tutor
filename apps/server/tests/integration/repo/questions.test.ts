import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { QuestionType } from '@lang-tutor/core/domain';

import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';
import { content, optionsFor } from '../../../src/db/content';
import { dictSenses, dictVariants } from '../../../src/db/schema';
import { optionsFor as generatedOptions, type QuestionOption } from '../../../src/domain/distractors';
import { asChoice } from '../../support/questions';
import { seedSavedSenses } from '../../support/vocabularyRows';
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
      const pool = await createQuestionRepo(tx).loadQuestionPool('en', 'he');
      expect(pool).toHaveLength(
        content.filter((entry) => entry.from === 'en' && entry.to === 'he').length,
      );
    });
  });

  it('returns options in canonical order with correct_option pointing at the right one', async () => {
    await withTx(t.db, async (tx) => {
      const pool = await createQuestionRepo(tx).loadQuestionPool('en', 'he');
      const entry = content.find((row) => row.question_id === 'q-window')!;
      const question = asChoice(pool.find((q) => q.id === 'q-window'));
      expect(question.options).toEqual(optionsFor(entry).map((option) => option.text));
      expect(question.correct_option).toBe(entry.correct_option);
    });
  });

  it("uses the term variant's form as the prompt, not the lemma", async () => {
    await withTx(t.db, async (tx) => {
      const pool = await createQuestionRepo(tx).loadQuestionPool('en', 'he');
      expect(pool.find((q) => q.id === 'q-remember')!.question).toBe('to remember');
    });
  });

  it('exposes the lexeme id, which the database issues', async () => {
    await withTx(t.db, async (tx) => {
      const pool = await createQuestionRepo(tx).loadQuestionPool('en', 'he');
      // Server-issued since phase 10 — no layer generates randomness, so the
      // authored `vt-en-window` is gone.
      expect(pool.find((q) => q.id === 'q-window')!.vocab_term_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  it('returns nothing for a language pair with no content', async () => {
    await withTx(t.db, async (tx) => {
      expect(await createQuestionRepo(tx).loadQuestionPool('es', 'ru')).toEqual([]);
    });
  });
});

describe('phase 19', () => {
  it('the seed pool never contains enrollment-owned questions', async () => {
    const [{ id: senseId }] = await t.db.select({ id: dictSenses.id }).from(dictSenses).limit(1);
    const [{ id: variantId }] = await t.db.select({ id: dictVariants.id }).from(dictVariants).limit(1);
    await withTx(t.db, (tx) =>
      createQuestionRepo(tx).insertGeneratedQuestions({
        userId: 'u_1',
        enrollmentId: enrollmentOf('u_1'),
        targetLanguage: 'en',
        userLanguageCode: 'he',
        questions: [
          {
            senseId,
            variantId,
            form: 'x',
            lemma: 'x',
            partOfSpeech: 'noun',
            lexemeId: 'unused',
            type: 'multiple_choice',
            prompt: null,
            options: generatedOptions('א', ['ב', 'ג', 'ד']),
            alternatives: null,
            tiles: null,
          },
        ],
      }),
    );
    const pool = await withTx(t.db, (tx) => createQuestionRepo(tx).loadQuestionPool('en', 'he'));
    expect(pool.every((q) => q.id.startsWith('q-'))).toBe(true);
  });

  it('reads the generation context in pick order, dropping a pick that is gone', async () => {
    const book = await seedSavedSenses(t.db, { enrollmentId: enrollmentOf('u_1'), lemma: 'tome', translations: ['ספר'] });
    const run = await seedSavedSenses(t.db, { enrollmentId: enrollmentOf('u_1'), lemma: 'sprint', translations: ['ריצה'] });
    const context = await withTx(t.db, (tx) =>
      createQuestionRepo(tx).findGenerationContext({
        picks: [
          { senseId: run.senseIds[0], variantId: run.variantId },
          { senseId: 'gone', variantId: 'gone' },
          { senseId: book.senseIds[0], variantId: book.variantId },
        ],
        sourceLanguage: 'he',
      }),
    );
    expect(context).toEqual([
      { senseId: run.senseIds[0], variantId: run.variantId, lexemeId: run.lexemeId, form: 'sprint', lemma: 'sprint', partOfSpeech: 'noun', translation: 'ריצה' },
      { senseId: book.senseIds[0], variantId: book.variantId, lexemeId: book.lexemeId, form: 'tome', lemma: 'tome', partOfSpeech: 'noun', translation: 'ספר' },
    ]);
  });

  it('inserts generated questions owned by the enrollment, correct option first', async () => {
    const word = await seedSavedSenses(t.db, { enrollmentId: enrollmentOf('u_1'), lemma: 'tome', translations: ['ספר'] });
    const [question] = await withTx(t.db, (tx) =>
      createQuestionRepo(tx).insertGeneratedQuestions({
        userId: 'u_1',
        enrollmentId: enrollmentOf('u_1'),
        targetLanguage: 'en',
        userLanguageCode: 'he',
        questions: [
          {
            senseId: word.senseIds[0],
            variantId: word.variantId,
            form: 'tome',
            lemma: 'tome',
            partOfSpeech: 'noun',
            lexemeId: word.lexemeId,
            type: 'multiple_choice',
            prompt: null,
            options: generatedOptions('ספר', ['עט', 'דף', 'מחברת']),
            alternatives: null,
            tiles: null,
          },
        ],
      }),
    );
    expect(question).toMatchObject({ question: 'tome', options: ['ספר', 'עט', 'דף', 'מחברת'], correct_option: 0, vocab_term_id: word.lexemeId });
  });
});

describe('phase 23: reversed and typed questions', () => {
  it('inserts a reversed and a typed question and returns them in shape', async () => {
    const word = await seedSavedSenses(t.db, { enrollmentId: enrollmentOf('u_1'), lemma: 'tome', translations: ['ספר'] });
    const base = { senseId: word.senseIds[0], variantId: word.variantId, form: 'tome', lemma: 'tome', partOfSpeech: 'noun', lexemeId: word.lexemeId };
    const [reversed, typed] = await withTx(t.db, (tx) =>
      createQuestionRepo(tx).insertGeneratedQuestions({
        userId: 'u_1',
        enrollmentId: enrollmentOf('u_1'),
        targetLanguage: 'en',
        userLanguageCode: 'he',
        questions: [
          { ...base, type: 'reverse_choice', prompt: 'ספר', options: generatedOptions('tome', ['pen', 'page', 'desk']), alternatives: null, tiles: null },
          { ...base, type: 'typed_translation', prompt: 'ספר', options: null, alternatives: ['book', 'volume'], tiles: null },
        ],
      }),
    );
    expect(reversed).toMatchObject({
      type: 'reverse_choice',
      question: 'ספר',
      part_of_speech: 'noun',
      options: ['tome', 'pen', 'page', 'desk'],
      correct_option: 0,
    });
    expect(typed).toEqual({
      id: typed.id,
      type: 'typed_translation',
      vocab_term_id: word.lexemeId,
      question: 'ספר',
      part_of_speech: 'noun',
      answer: 'tome',
      lemma: 'tome',
      alternatives: ['book', 'volume'],
    });
  });

  // questions_shape_valid (spec D13).
  const BAD: {
    label: string;
    type: QuestionType;
    prompt: string | null;
    options: QuestionOption[] | null;
    alternatives: string[] | null;
  }[] = [
    { label: 'a typed question with options', type: 'typed_translation', prompt: 'ספר', options: generatedOptions('tome', ['a', 'b', 'c']), alternatives: [] },
    { label: 'a typed question without a prompt', type: 'typed_translation', prompt: null, options: null, alternatives: [] },
    { label: 'a typed question with six alternatives', type: 'typed_translation', prompt: 'ספר', options: null, alternatives: ['a', 'b', 'c', 'd', 'e', 'f'] },
    { label: 'a reversed question without a prompt', type: 'reverse_choice', prompt: null, options: generatedOptions('tome', ['a', 'b', 'c']), alternatives: null },
    { label: 'a choice with a prompt', type: 'multiple_choice', prompt: 'ספר', options: generatedOptions('ספר', ['a', 'b', 'c']), alternatives: null },
  ];

  for (const bad of BAD) {
    it(`refuses ${bad.label}`, async () => {
      const word = await seedSavedSenses(t.db, { enrollmentId: enrollmentOf('u_1'), lemma: 'tome', translations: ['ספר'] });
      await expect(
        withTx(t.db, (tx) =>
          createQuestionRepo(tx).insertGeneratedQuestions({
            userId: 'u_1',
            enrollmentId: enrollmentOf('u_1'),
            targetLanguage: 'en',
            userLanguageCode: 'he',
            questions: [
              {
                senseId: word.senseIds[0],
                variantId: word.variantId,
                form: 'tome',
                lemma: 'tome',
                partOfSpeech: 'noun',
                lexemeId: word.lexemeId,
                type: bad.type,
                prompt: bad.prompt,
                options: bad.options,
                alternatives: bad.alternatives,
                tiles: null,
              },
            ],
          }),
        ),
      ).rejects.toThrow();
    });
  }
});
