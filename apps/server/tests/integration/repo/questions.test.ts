import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { QuestionType } from '@lang-tutor/core/domain';
import { eq, sql } from 'drizzle-orm';

import { insertLexeme } from '../../support/dictRows';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';
import { content, optionsFor } from '../../../src/db/content';
import { dictGlosses, dictSenseGlosses, dictVariants } from '../../../src/db/schema';
import { NOTHING_GENERATED, NO_EXTRAS, generatedContent, optionsFor as generatedOptions, type QuestionOption } from '../../../src/domain/distractors';
import { meaningRuleVerdict } from '../../../src/domain/judge';
import { asChoice, insertListSession } from '../../support/questions';
import { seedSavedSenses } from '../../support/vocabularyRows';
import { createQuestionRepo } from '../../../src/repo/questions';
import { createSessionRepo } from '../../../src/repo/sessions';

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
      expect(pool.find((q) => q.id === 'q-remember')).toMatchObject({ question: 'to remember' });
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
    const [{ id: glossId }] = await t.db.select({ id: dictGlosses.id }).from(dictGlosses).limit(1);
    const [{ id: variantId }] = await t.db.select({ id: dictVariants.id }).from(dictVariants).limit(1);
    await withTx(t.db, (tx) =>
      createQuestionRepo(tx).insertGeneratedQuestions({
        userId: 'u_1',
        enrollmentId: enrollmentOf('u_1'),
        targetLanguage: 'en',
        userLanguageCode: 'he',
        questions: [
          {
            glossId,
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
          { glossId: run.glossIds[0], senseId: run.senseIds[0], variantId: run.variantId },
          { glossId: 'gone', senseId: 'gone', variantId: 'gone' },
          { glossId: book.glossIds[0], senseId: book.senseIds[0], variantId: book.variantId },
        ],
        sourceLanguage: 'he',
      }),
    );
    expect(context).toEqual([
      { glossId: run.glossIds[0], senseId: run.senseIds[0], variantId: run.variantId, lexemeId: run.lexemeId, form: 'sprint', lemma: 'sprint', partOfSpeech: 'noun', translation: 'ריצה', example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null },
      { glossId: book.glossIds[0], senseId: book.senseIds[0], variantId: book.variantId, lexemeId: book.lexemeId, form: 'tome', lemma: 'tome', partOfSpeech: 'noun', translation: 'ספר', example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null },
    ]);
  });

  // Phase 34 (spec D1, D2; ruling R1). What the accept job stored, read with the pick.
  it('reads the generation context with the accepted answers, the answer form and the stamp', async () => {
    const book = await seedSavedSenses(t.db, { enrollmentId: enrollmentOf('u_1'), lemma: 'tome', translations: ['ספרים'] });
    const at = new Date('2026-10-11T09:30:15.123Z');
    await t.db.execute(sql`
      update dict_var_translations set accepted_answers = array['tomes','volumes'], answer_form = 'tomes', accepted_at = ${at.toISOString()}
      where variant_id = ${book.variantId}`);
    const [row] = await withTx(t.db, (tx) =>
      createQuestionRepo(tx).findGenerationContext({
        picks: [{ glossId: book.glossIds[0], senseId: book.senseIds[0], variantId: book.variantId }],
        sourceLanguage: 'he',
      }),
    );
    expect(row).toMatchObject({ acceptedAnswers: ['tomes', 'volumes'], answerForm: 'tomes', acceptedAt: at });
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
            glossId: word.glossIds[0],
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
    const base = { glossId: word.glossIds[0], variantId: word.variantId, form: 'tome', lemma: 'tome', partOfSpeech: 'noun', lexemeId: word.lexemeId };
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
      context: null,
    });
  });

  // questions_shape_valid (spec D13).
  const BAD: {
    label: string;
    type: QuestionType;
    prompt: string | null;
    options: QuestionOption[] | null;
    alternatives: string[] | null;
    tiles: string[] | null;
  }[] = [
    { label: 'a typed question with options', type: 'typed_translation', prompt: 'ספר', options: generatedOptions('tome', ['a', 'b', 'c']), alternatives: [], tiles: null },
    { label: 'a typed question without a prompt', type: 'typed_translation', prompt: null, options: null, alternatives: [], tiles: null },
    { label: 'a typed question with eleven alternatives', type: 'typed_translation', prompt: 'ספר', options: null, alternatives: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'], tiles: null },
    { label: 'a reversed question without a prompt', type: 'reverse_choice', prompt: null, options: generatedOptions('tome', ['a', 'b', 'c']), alternatives: null, tiles: null },
    { label: 'a choice with a prompt', type: 'multiple_choice', prompt: 'ספר', options: generatedOptions('ספר', ['a', 'b', 'c']), alternatives: null, tiles: null },
    { label: 'a dictation with options', type: 'dictation', prompt: 'ספר', options: generatedOptions('tome', ['a', 'b', 'c']), alternatives: null, tiles: null },
    { label: 'a dictation without its meaning', type: 'dictation', prompt: null, options: null, alternatives: null, tiles: null },
    { label: 'a tiles card with four tiles', type: 'letter_tiles', prompt: 'ספר', options: null, alternatives: null, tiles: ['t', 'o', 'm', 'e'] },
    { label: 'a listening card with a prompt', type: 'listen_choice', prompt: 'ספר', options: generatedOptions('ספר', ['a', 'b', 'c']), alternatives: null, tiles: null },
    { label: 'a board word with tiles', type: 'matching', prompt: null, options: generatedOptions('ספר', ['a', 'b', 'c']), alternatives: null, tiles: ['t', 'o', 'm', 'e', 'x'] },
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
                glossId: word.glossIds[0],
                variantId: word.variantId,
                form: 'tome',
                lemma: 'tome',
                partOfSpeech: 'noun',
                lexemeId: word.lexemeId,
                type: bad.type,
                prompt: bad.prompt,
                options: bad.options,
                alternatives: bad.alternatives,
                tiles: bad.tiles,
              },
            ],
          }),
        ),
      ).rejects.toThrow();
    });
  }
});

describe('phase 25: speaking questions', () => {
  it('stores and reads back both speaking types (phase 25)', async () => {
    const asked = [];
    for (const [lemma, translation] of [
      ['tome', 'ספר'],
      ['lantern', 'פנס'],
    ]) {
      const saved = await seedSavedSenses(t.db, { enrollmentId: enrollmentOf('u_1'), lemma, translations: [translation] });
      asked.push({ glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation });
    }
    const { questions } = await insertListSession(t.db, {
      userId: 'u_1',
      enrollmentId: enrollmentOf('u_1'),
      asked,
      alternatives: ['lamp'],
      types: ['read_aloud', 'say_translation'],
    });
    expect(questions[0]).toEqual({ id: questions[0].id, type: 'read_aloud', vocab_term_id: asked[0].lexemeId, question: 'tome', meaning: 'ספר' });
    expect(questions[1]).toEqual({
      id: questions[1].id,
      type: 'say_translation',
      vocab_term_id: asked[1].lexemeId,
      question: 'פנס',
      part_of_speech: 'noun',
      answer: 'lantern',
      lemma: 'lantern',
      alternatives: ['lamp'],
      context: null,
    });
  });
});

describe('phase 27: meaning recall', () => {
  async function meaningSession(example?: { source: string; target: string }) {
    const saved = await seedSavedSenses(t.db, {
      enrollmentId: enrollmentOf('u_1'),
      lemma: 'reserve',
      form: 'to book',
      translations: ['להזמין'],
      example,
    });
    const asked = [
      { glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: 'to book', lemma: 'reserve', translation: 'להזמין' },
    ];
    const { questions } = await insertListSession(t.db, {
      userId: 'u_1',
      enrollmentId: enrollmentOf('u_1'),
      asked,
      types: ['typed_meaning'],
    });
    return { questions, saved };
  }

  it('loads a typed_meaning question with its form, part of speech and meaning (phase 27)', async () => {
    const { questions, saved } = await meaningSession();
    expect(questions[0]).toEqual({
      id: questions[0].id,
      type: 'typed_meaning',
      vocab_term_id: saved.lexemeId,
      question: 'to book',
      part_of_speech: 'noun',
      meaning: 'להזמין',
      context: null,
    });
  });

  it('findJudgeContext reads the lemma, part of speech, meaning and the saved example (phase 27)', async () => {
    const { questions } = await meaningSession({
      source: 'Vorrei prenotare un tavolo.',
      target: 'הייתי רוצה להזמין שולחן.',
    });
    await withTx(t.db, async (tx) => {
      const repo = createQuestionRepo(tx);
      expect(await repo.findJudgeContext(questions[0].id)).toEqual({
        form: 'to book',
        lemma: 'reserve',
        partOfSpeech: 'noun',
        meaning: 'להזמין',
        example: 'Vorrei prenotare un tavolo.',
        exampleTranslation: 'הייתי רוצה להזמין שולחן.',
        alternatives: [],
      });
      expect(await repo.findJudgeContext('00000000-0000-0000-0000-000000000000')).toBeUndefined();
      expect(await repo.findJudgeContext('not-a-uuid')).toBeUndefined();
    });
  });

  it('findJudgeContext gives null examples when none is saved (phase 27)', async () => {
    const { questions } = await meaningSession();
    await withTx(t.db, async (tx) => {
      expect(await createQuestionRepo(tx).findJudgeContext(questions[0].id)).toMatchObject({
        example: null,
        exampleTranslation: null,
      });
    });
  });
});

// The words the meaning judge's rule accepts besides the stored meaning (spec D13):
// the asked form's rendering lists its sense's other words in its own inflection,
// and the gloss holds its key and lists the others, in citation form.
describe('phase 31: findJudgeContext reads the stored alternatives (spec D13)', () => {
  /** A meaning card for `cars`, which renders מכוניות under the gloss מכונית. */
  async function carsSession() {
    const car = await insertLexeme(t.db, {
      lemma: 'car',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'vehicle' }],
      variants: [
        {
          form: 'cars',
          kind: 'word',
          entryRank: 0,
          translations: [
            { senseCode: 'vehicle', rank: 0, translation: 'מכוניות', gloss: 'מכונית', alternatives: ['רכבים'], exampleSource: null, exampleTarget: null },
          ],
        },
      ],
    });
    await t.db.update(dictGlosses).set({ alternatives: ['רכב'] }).where(eq(dictGlosses.id, car.glossIds[0]));
    const { questions } = await insertListSession(t.db, {
      userId: 'u_1',
      enrollmentId: enrollmentOf('u_1'),
      asked: [{ glossId: car.glossIds[0], variantId: car.variantIds[0], lexemeId: car.lexemeId, form: 'cars', lemma: 'car', translation: 'מכוניות' }],
      types: ['typed_meaning'],
    });
    return { questions, car };
  }

  it("gets the rendering's other words, then the gloss's key and other words", async () => {
    const { questions } = await carsSession();
    await withTx(t.db, async (tx) => {
      expect(await createQuestionRepo(tx).findJudgeContext(questions[0].id)).toMatchObject({
        form: 'cars',
        meaning: 'מכוניות',
        alternatives: ['רכבים', 'מכונית', 'רכב'],
      });
    });
  });

  it("gets the gloss's alone when no rendering is found for the form", async () => {
    // The rendering is a left join: a card whose gloss has no member rendered by its form still has its gloss's words.
    const { questions, car } = await carsSession();
    await t.db.delete(dictSenseGlosses).where(eq(dictSenseGlosses.glossId, car.glossIds[0]));
    await withTx(t.db, async (tx) => {
      expect(await createQuestionRepo(tx).findJudgeContext(questions[0].id)).toMatchObject({
        example: null,
        alternatives: ['מכונית', 'רכב'],
      });
    });
  });

  // The list and the word page head a saved word with its gloss key (D11), so
  // a learner asked the meaning of `fingers` may well type that citation form.
  it('takes the gloss key, so the citation form the list shows is right by rule, with no judge call', async () => {
    const finger = await insertLexeme(t.db, {
      lemma: 'finger',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'body_part' }],
      variants: [
        {
          form: 'fingers',
          kind: 'word',
          entryRank: 0,
          translations: [{ senseCode: 'body_part', rank: 0, translation: 'אצבעות', gloss: 'אצבע', exampleSource: null, exampleTarget: null }],
        },
      ],
    });
    const { questions } = await insertListSession(t.db, {
      userId: 'u_1',
      enrollmentId: enrollmentOf('u_1'),
      asked: [{ glossId: finger.glossIds[0], variantId: finger.variantIds[0], lexemeId: finger.lexemeId, form: 'fingers', lemma: 'finger', translation: 'אצבעות' }],
      types: ['typed_meaning'],
    });
    await withTx(t.db, async (tx) => {
      const context = await createQuestionRepo(tx).findJudgeContext(questions[0].id);
      expect(context).toMatchObject({ form: 'fingers', meaning: 'אצבעות', alternatives: ['אצבע'] });
      expect(meaningRuleVerdict(context!.meaning, 'אצבע', context!.alternatives)).toBe('exact');
    });
  });

  // A key that is the meaning itself is not another word: a lemma form's card.
  it('leaves out a key that is the stored meaning', async () => {
    const saved = await seedSavedSenses(t.db, { enrollmentId: enrollmentOf('u_1'), lemma: 'car', translations: ['מכונית'] });
    const { questions } = await insertListSession(t.db, {
      userId: 'u_1',
      enrollmentId: enrollmentOf('u_1'),
      asked: [{ glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: 'car', lemma: 'car', translation: 'מכונית' }],
      types: ['typed_meaning'],
    });
    await withTx(t.db, async (tx) => {
      expect(await createQuestionRepo(tx).findJudgeContext(questions[0].id)).toMatchObject({ meaning: 'מכונית', alternatives: [] });
    });
  });
});

describe('phase 27 Part B: sentence cards', () => {
  const SENTENCE = 'Ieri parlavamo per ore.';
  const HEBREW = 'אתמול דיברנו שעות.';

  async function savedWord(example?: { source: string; target: string }) {
    return seedSavedSenses(t.db, {
      enrollmentId: enrollmentOf('u_1'),
      lemma: 'parlare',
      form: 'parlavamo',
      translations: ['לדבר'],
      example,
    });
  }

  type SentenceExtra = {
    type: QuestionType;
    options?: QuestionOption[] | null;
    alternatives?: string[] | null;
    sentence?: string;
    sentenceTranslation?: string;
    gapStart?: number;
    gapEnd?: number;
  };
  const sentenceRow = (word: Awaited<ReturnType<typeof savedWord>>, extra: SentenceExtra) => ({
    glossId: word.glossIds[0],
    variantId: word.variantId,
    form: 'parlavamo',
    lemma: 'parlare',
    partOfSpeech: 'noun',
    lexemeId: word.lexemeId,
    prompt: 'לדבר',
    options: null,
    alternatives: null,
    tiles: null,
    sentence: SENTENCE,
    sentenceTranslation: HEBREW,
    gapStart: 5,
    gapEnd: 14,
    ...extra,
  });

  it('writes the three sentence types and loads each back in its shape (questionFrom)', async () => {
    const word = await savedWord();
    const [choice, typed, translation] = await withTx(t.db, (tx) =>
      createQuestionRepo(tx).insertGeneratedQuestions({
        userId: 'u_1',
        enrollmentId: enrollmentOf('u_1'),
        targetLanguage: 'it',
        userLanguageCode: 'he',
        questions: [
          sentenceRow(word, { type: 'cloze_choice', options: generatedOptions('parlavamo', ['parlammo', 'parlate', 'parlano']) }),
          sentenceRow(word, { type: 'cloze_typed', alternatives: ['parlammo'] }),
          sentenceRow(word, { type: 'sentence_translation', sentence: 'Yesterday we talked for hours.', sentenceTranslation: HEBREW, gapStart: 13, gapEnd: 19 }),
        ],
      }),
    );
    const gap = { start: 5, end: 14 };
    expect(choice).toEqual({
      id: choice.id,
      type: 'cloze_choice',
      vocab_term_id: word.lexemeId,
      sentence: SENTENCE,
      gap,
      translation: HEBREW,
      meaning: 'לדבר',
      options: ['parlavamo', 'parlammo', 'parlate', 'parlano'],
      correct_option: 0,
    });
    expect(typed).toEqual({
      id: typed.id,
      type: 'cloze_typed',
      vocab_term_id: word.lexemeId,
      sentence: SENTENCE,
      gap,
      translation: HEBREW,
      meaning: 'לדבר',
      answer: 'parlavamo',
      alternatives: ['parlammo'],
      mark: null,
    });
    expect(translation).toEqual({
      id: translation.id,
      type: 'sentence_translation',
      vocab_term_id: word.lexemeId,
      question: HEBREW,
      meaning: 'לדבר',
      sentence: 'Yesterday we talked for hours.',
      gap: { start: 13, end: 19 },
      answer: 'talked',
      mark: null,
    });

    // loadSession reads the same shapes from the stored rows.
    const sessionId = await withTx(t.db, async (tx) => {
      const sessions = createSessionRepo(tx);
      const id = await sessions.insertPreparingSession('u_1', enrollmentOf('u_1'));
      await sessions.insertSessionQuestions(id, [choice, typed, translation]);
      await sessions.transition(id, ['preparing'], 'ready');
      return id;
    });
    const loaded = await withTx(t.db, (tx) => createSessionRepo(tx).loadSession(sessionId));
    expect(loaded!.questions).toEqual([choice, typed, translation]);
  });

  it('refuses a sentence card whose gap lies outside its sentence', async () => {
    const word = await savedWord();
    await expect(
      withTx(t.db, (tx) =>
        createQuestionRepo(tx).insertGeneratedQuestions({
          userId: 'u_1',
          enrollmentId: enrollmentOf('u_1'),
          targetLanguage: 'it',
          userLanguageCode: 'he',
          questions: [sentenceRow(word, { type: 'cloze_typed', alternatives: [], gapEnd: 99 })],
        }),
      ),
    ).rejects.toThrow();
  });

  it('findGenerationContext returns the saved example and its translation', async () => {
    const word = await savedWord({ source: SENTENCE, target: HEBREW });
    const bare = await seedSavedSenses(t.db, { enrollmentId: enrollmentOf('u_1'), lemma: 'tome', translations: ['ספר'] });
    const context = await withTx(t.db, (tx) =>
      createQuestionRepo(tx).findGenerationContext({
        picks: [
          { glossId: word.glossIds[0], senseId: word.senseIds[0], variantId: word.variantId },
          { glossId: bare.glossIds[0], senseId: bare.senseIds[0], variantId: bare.variantId },
        ],
        sourceLanguage: 'he',
      }),
    );
    expect(context.map((row) => [row.example, row.exampleTranslation])).toEqual([
      [SENTENCE, HEBREW],
      [null, null],
    ]);
  });

  describe('findRecentSentences', () => {
    async function ask(word: Awaited<ReturnType<typeof savedWord>>, enrollmentId: string, userId: string, rows: SentenceExtra[]) {
      // One transaction each, so created_at orders them.
      await withTx(t.db, (tx) =>
        createQuestionRepo(tx).insertGeneratedQuestions({
          userId,
          enrollmentId,
          targetLanguage: 'it',
          userLanguageCode: 'he',
          questions: rows.map((row) => sentenceRow(word, row)),
        }),
      );
    }
    const typedWith = (n: number): SentenceExtra => ({ type: 'cloze_typed', alternatives: [], sentence: `Ieri parlavamo ${n}.`, gapStart: 5, gapEnd: 14 });
    const translateWith = (n: number): SentenceExtra => ({ type: 'sentence_translation', sentence: `We parlavamo ${n}.`, sentenceTranslation: `דיברנו ${n}.`, gapStart: 3, gapEnd: 12 });

    it('returns, per gloss, newest first, only this enrollment, only the two types, at most limit', async () => {
      await seedUser(t.db, 'u_2');
      const word = await savedWord();
      const enrollmentId = enrollmentOf('u_1');
      await ask(word, enrollmentId, 'u_1', [typedWith(1)]);
      await ask(word, enrollmentId, 'u_1', [translateWith(1)]);
      await ask(word, enrollmentId, 'u_1', [typedWith(2)]);
      // A cloze_choice shows the saved example, which is not a written sentence.
      await ask(word, enrollmentId, 'u_1', [{ type: 'cloze_choice', options: generatedOptions('parlavamo', ['a', 'b', 'c']), sentence: 'Ieri parlavamo 9.' }]);
      await ask(word, enrollmentId, 'u_1', [typedWith(3)]);
      // Another learner's question for the same gloss.
      await ask(word, enrollmentOf('u_2'), 'u_2', [typedWith(7)]);
      await ask(word, enrollmentId, 'u_1', [translateWith(2)]);

      const read = (limit: number, glossIds = [word.glossIds[0], 'other']) =>
        withTx(t.db, (tx) => createQuestionRepo(tx).findRecentSentences({ enrollmentId, glossIds, limit }));

      const recent = await read(2);
      expect(recent.get(word.glossIds[0])).toEqual({
        cloze: ['Ieri parlavamo 3.', 'Ieri parlavamo 2.'],
        // The Hebrew sentence asked, not the reference that follows the answer.
        translate: ['דיברנו 2.', 'דיברנו 1.'],
      });
      expect((await read(10)).get(word.glossIds[0])!.cloze).toEqual(['Ieri parlavamo 3.', 'Ieri parlavamo 2.', 'Ieri parlavamo 1.']);
      // A gloss with none has no entry; no glosses is an empty map.
      expect(recent.has('other')).toBe(false);
      expect((await read(2, [])).size).toBe(0);
    });
  });
});

// Phase 34 (spec D2, D12). A question stores the form its card asks for, and the
// repository's question mapping is the one place that turns it into the wire's
// shown form and answer.
describe('phase 34: the answer form a card asks for', () => {
  const SIX: QuestionType[] = ['multiple_choice', 'listen_choice', 'reverse_choice', 'typed_translation', 'say_translation', 'letter_tiles'];

  async function loaded(answerForm: string | null) {
    const saved = await seedSavedSenses(t.db, { enrollmentId: enrollmentOf('u_1'), lemma: 'ora', languageCode: 'it', translations: ['שעות'] });
    const row = {
      glossId: saved.glossIds[0], senseId: saved.senseIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: 'ora', lemma: 'ora',
      partOfSpeech: 'noun', translation: 'שעות', example: null, exampleTranslation: null, acceptedAnswers: [], answerForm, acceptedAt: null,
    };
    const generated = { ...NOTHING_GENERATED, distractors: ['x1', 'x2', 'x3'], alternatives: ['ore'] };
    const { sessionId } = await withTx(t.db, async (tx) => {
      const made = await createQuestionRepo(tx).insertGeneratedQuestions({
        userId: 'u_1',
        enrollmentId: enrollmentOf('u_1'),
        targetLanguage: 'it',
        userLanguageCode: 'he',
        questions: SIX.map((type) => ({
          glossId: row.glossId,
          variantId: row.variantId,
          form: row.form,
          lemma: row.lemma,
          partOfSpeech: row.partOfSpeech,
          lexemeId: row.lexemeId,
          type,
          ...generatedContent(row, type, generated, { ...NO_EXTRAS, tiles: type === 'letter_tiles' ? ['o', 'r', 'a', 'x', 'z'] : null }),
        })),
      });
      const sessions = createSessionRepo(tx);
      const id = await sessions.insertPreparingSession('u_1', enrollmentOf('u_1'));
      await sessions.insertSessionQuestions(id, made);
      await sessions.transition(id, ['preparing'], 'ready');
      return { sessionId: id };
    });
    const record = (await withTx(t.db, (tx) => createSessionRepo(tx).loadSession(sessionId)))!;
    const stored = await t.db.execute<{ type: string; answer_form: string | null }>(sql`select type, answer_form from questions where enrollment_id = ${enrollmentOf('u_1')} order by type`);
    return { sessionId, questions: record.questions, stored: stored.rows };
  }

  it('shows and asks for the stored form on all six cards, and keeps the rendering', async () => {
    const { questions, stored } = await loaded('ore');
    const byType = Object.fromEntries(questions.map((q) => [q.type, q]));
    expect(byType.multiple_choice).toMatchObject({ question: 'ore' });
    expect(byType.listen_choice).toMatchObject({ question: 'ore' });
    expect(byType.reverse_choice).toMatchObject({ question: 'שעות' });
    expect(asChoice(byType.reverse_choice).options[asChoice(byType.reverse_choice).correct_option]).toBe('ore');
    expect(asChoice(byType.multiple_choice).options[asChoice(byType.multiple_choice).correct_option]).toBe('שעות');
    expect(byType.typed_translation).toMatchObject({ question: 'שעות', answer: 'ore', lemma: 'ora' });
    expect(byType.say_translation).toMatchObject({ question: 'שעות', answer: 'ore', lemma: 'ora' });
    expect(byType.letter_tiles).toMatchObject({ question: 'שעות', answer: 'ore' });
    expect(stored.map((row) => row.answer_form)).toEqual(Array(6).fill('ore'));
  });

  it('shows the variant’s own form when none is stored', async () => {
    const { questions, stored } = await loaded(null);
    const byType = Object.fromEntries(questions.map((q) => [q.type, q]));
    expect(byType.multiple_choice).toMatchObject({ question: 'ora' });
    expect(byType.listen_choice).toMatchObject({ question: 'ora' });
    expect(byType.typed_translation).toMatchObject({ answer: 'ora' });
    expect(byType.say_translation).toMatchObject({ answer: 'ora' });
    expect(byType.letter_tiles).toMatchObject({ answer: 'ora' });
    expect(asChoice(byType.reverse_choice).options[asChoice(byType.reverse_choice).correct_option]).toBe('ora');
    expect(stored.every((row) => row.answer_form === null)).toBe(true);
  });

  it('is a form a later change of the dictionary cannot alter: the question holds its own', async () => {
    const { sessionId } = await loaded('ore');
    await t.db.execute(sql`update dict_var_translations set answer_form = 'orario', accepted_answers = array['orario']`);
    // Read again, after the change, through the path a resumed session takes.
    const record = (await withTx(t.db, (tx) => createSessionRepo(tx).loadSession(sessionId)))!;
    expect(record.questions.find((q) => q.type === 'typed_translation')).toMatchObject({ answer: 'ore' });
    expect(record.questions.find((q) => q.type === 'multiple_choice')).toMatchObject({ question: 'ore' });
  });
});

// Phase 34 (spec D6, D7, D8, D10, D12). A question stores the sentence its card
// showed beside the word, that sentence's other half, the marked words, and the
// card reads them back; the meaning judge reads the card's pair.
describe('phase 34: context sentences, marks and part of speech', () => {
  const FIVE: QuestionType[] = ['multiple_choice', 'reverse_choice', 'typed_translation', 'say_translation', 'typed_meaning'];
  const SAW_SENTENCE = 'Please saw the plank in half.';
  const SAW_HEBREW = 'בבקשה תנסר את הקרש לשניים.';

  async function savedSaw(example?: { source: string; target: string }) {
    return seedSavedSenses(t.db, { enrollmentId: enrollmentOf('u_1'), lemma: 'saw', languageCode: 'en', partOfSpeech: 'verb', translations: ['לנסר'], example });
  }
  type Saved = Awaited<ReturnType<typeof savedSaw>>;
  const base = (word: Saved, type: QuestionType) => ({
    glossId: word.glossIds[0],
    variantId: word.variantId,
    form: 'saw',
    lemma: 'saw',
    partOfSpeech: 'verb',
    lexemeId: word.lexemeId,
    type,
    prompt: type === 'multiple_choice' || type === 'listen_choice' || type === 'matching' ? null : 'לנסר',
    options: ['multiple_choice', 'reverse_choice', 'listen_choice', 'matching'].includes(type) ? generatedOptions(type === 'reverse_choice' ? 'saw' : 'לנסר', ['a', 'b', 'c']) : null,
    alternatives: type === 'typed_translation' || type === 'say_translation' || type === 'cloze_typed' ? [] : null,
    tiles: null,
  });

  async function inSession(rows: Parameters<ReturnType<typeof createQuestionRepo>['insertGeneratedQuestions']>[0]['questions']) {
    return withTx(t.db, async (tx) => {
      const made = await createQuestionRepo(tx).insertGeneratedQuestions({
        userId: 'u_1', enrollmentId: enrollmentOf('u_1'), targetLanguage: 'en', userLanguageCode: 'he', questions: rows,
      });
      const sessions = createSessionRepo(tx);
      const id = await sessions.insertPreparingSession('u_1', enrollmentOf('u_1'));
      await sessions.insertSessionQuestions(id, made);
      await sessions.transition(id, ['preparing'], 'ready');
      return { sessionId: id, made };
    });
  }
  const load = async (sessionId: string) => (await withTx(t.db, (tx) => createSessionRepo(tx).loadSession(sessionId)))!.questions;

  it('stores a context, its other half and its mark on the five cards, and each card shows the sentence and its mark (spec D6, D12)', async () => {
    const word = await savedSaw();
    const { sessionId, made } = await inSession(
      FIVE.map((type) => ({
        ...base(word, type),
        context: SAW_SENTENCE, contextTranslation: SAW_HEBREW, contextMarkStart: 7, contextMarkEnd: 10,
      })),
    );
    for (const question of [...made, ...(await load(sessionId))]) {
      expect(question).toMatchObject({ context: { text: SAW_SENTENCE, mark: { start: 7, end: 10 } } });
    }
    // The other half is the judge's, never the wire's.
    expect(JSON.stringify(made)).not.toContain(SAW_HEBREW);
    const stored = await t.db.execute<{ context_translation: string }>(sql`select context_translation from questions where enrollment_id = ${enrollmentOf('u_1')}`);
    expect(stored.rows.map((row) => row.context_translation)).toEqual(Array(5).fill(SAW_HEBREW));
  });

  it('shows an unmarked context, and null where there is none', async () => {
    const word = await savedSaw();
    const { sessionId } = await inSession([
      { ...base(word, 'typed_meaning'), context: SAW_SENTENCE, contextTranslation: null },
      { ...base(word, 'multiple_choice') },
    ]);
    const [unmarked, none] = await load(sessionId);
    expect(unmarked).toMatchObject({ context: { text: SAW_SENTENCE, mark: null } });
    expect(none).toMatchObject({ context: null });
  });

  it('marks the practised word in a sentence card’s Hebrew, or not (spec D8)', async () => {
    const word = await savedSaw();
    const sentence = { sentence: "Let's combine forces.", sentenceTranslation: 'בואו נשלב כוחות.', gapStart: 6, gapEnd: 13 };
    const { sessionId } = await inSession([
      { ...base(word, 'cloze_typed'), ...sentence, sentenceMarkStart: 5, sentenceMarkEnd: 9 },
      { ...base(word, 'sentence_translation'), ...sentence, sentenceMarkStart: 5, sentenceMarkEnd: 9 },
      { ...base(word, 'sentence_translation'), ...sentence },
    ]);
    const [cloze, translation, unmarked] = await load(sessionId);
    expect(cloze).toMatchObject({ type: 'cloze_typed', translation: 'בואו נשלב כוחות.', mark: { start: 5, end: 9 } });
    expect(translation).toMatchObject({ type: 'sentence_translation', question: 'בואו נשלב כוחות.', mark: { start: 5, end: 9 } });
    expect(unmarked).toMatchObject({ mark: null });
  });

  it('gives a listen card and every word of a board its part of speech (spec D10)', async () => {
    const word = await savedSaw();
    const main = await seedSavedSenses(t.db, { enrollmentId: enrollmentOf('u_1'), lemma: 'main', languageCode: 'en', partOfSpeech: 'adjective', translations: ['ראשי'] });
    const { sessionId } = await inSession([
      { ...base(word, 'listen_choice') },
      { ...base(word, 'matching'), options: generatedOptions('לנסר', ['ראשי', 'c', 'd', 'e']) },
      { ...base(main, 'matching'), form: 'main', lemma: 'main', partOfSpeech: 'adjective', options: [{ position: 0, text: 'לנסר', is_correct: false }, { position: 1, text: 'ראשי', is_correct: true }, { position: 2, text: 'c', is_correct: false }, { position: 3, text: 'd', is_correct: false }, { position: 4, text: 'e', is_correct: false }] },
    ]);
    const [listen, first, second] = await load(sessionId);
    expect(listen).toMatchObject({ type: 'listen_choice', part_of_speech: 'verb' });
    expect(first).toMatchObject({ part_of_speech: 'verb', board: { words: ['saw', 'main'], parts_of_speech: ['verb', 'adjective'] } });
    expect(second).toMatchObject({ part_of_speech: 'adjective', board: { parts_of_speech: ['verb', 'adjective'] } });
  });

  it('refuses a context on a card that shows none, and a mark outside its sentence', async () => {
    const word = await savedSaw();
    const insert = (row: ReturnType<typeof base> & Record<string, unknown>) =>
      withTx(t.db, (tx) =>
        createQuestionRepo(tx).insertGeneratedQuestions({ userId: 'u_1', enrollmentId: enrollmentOf('u_1'), targetLanguage: 'en', userLanguageCode: 'he', questions: [row] }),
      );
    await expect(insert({ ...base(word, 'listen_choice'), context: SAW_SENTENCE })).rejects.toThrow();
    await expect(insert({ ...base(word, 'typed_meaning'), context: SAW_SENTENCE, contextMarkStart: 7, contextMarkEnd: 99 })).rejects.toThrow();
  });

  describe('findRecentContexts', () => {
    it('returns, per gloss and card type, the sentences shown, newest first, only this enrollment, at most limit', async () => {
      await seedUser(t.db, 'u_2');
      const word = await savedSaw();
      const ask = (enrollmentId: string, userId: string, type: QuestionType, context: string | null) =>
        withTx(t.db, (tx) =>
          createQuestionRepo(tx).insertGeneratedQuestions({
            userId, enrollmentId, targetLanguage: 'en', userLanguageCode: 'he',
            questions: [{ ...base(word, type), context }],
          }),
        );
      const mine = enrollmentOf('u_1');
      await ask(mine, 'u_1', 'typed_meaning', 'Saw one.');
      await ask(mine, 'u_1', 'multiple_choice', 'Saw it in two.');
      await ask(mine, 'u_1', 'typed_meaning', 'Saw two.');
      await ask(enrollmentOf('u_2'), 'u_2', 'typed_meaning', 'Saw elsewhere.');
      await ask(mine, 'u_1', 'typed_meaning', 'Saw three.');
      await ask(mine, 'u_1', 'typed_translation', 'נסר אחת.');
      // A card that showed no sentence (a sense with no example) is no recent sentence.
      await ask(mine, 'u_1', 'typed_meaning', null);

      const read = (limit: number, glossIds = [word.glossIds[0], 'other']) =>
        withTx(t.db, (tx) => createQuestionRepo(tx).findRecentContexts({ enrollmentId: mine, glossIds, limit }));
      const recent = await read(2);
      expect(recent.get(word.glossIds[0])).toEqual({
        typed_meaning: ['Saw three.', 'Saw two.'],
        multiple_choice: ['Saw it in two.'],
        typed_translation: ['נסר אחת.'],
      });
      expect(recent.has('other')).toBe(false);
      expect((await read(2, [])).size).toBe(0);
    });
  });

  // Spec D7: the judge sees what the learner saw.
  it('category E (71b0b407): findJudgeContext gives the meaning judge the sentence the card showed, and its other half', async () => {
    const word = await savedSaw({ source: 'He will saw the branch off.', target: 'הוא ינסר את הענף.' });
    const { made } = await inSession([
      { ...base(word, 'typed_meaning'), context: SAW_SENTENCE, contextTranslation: SAW_HEBREW, contextMarkStart: 7, contextMarkEnd: 10 },
      { ...base(word, 'typed_meaning') },
    ]);
    await withTx(t.db, async (tx) => {
      const repo = createQuestionRepo(tx);
      expect(await repo.findJudgeContext(made[0].id)).toMatchObject({ example: SAW_SENTENCE, exampleTranslation: SAW_HEBREW });
      // A card with no sentence of its own falls back on the saved example, as before phase 34.
      expect(await repo.findJudgeContext(made[1].id)).toMatchObject({
        example: 'He will saw the branch off.', exampleTranslation: 'הוא ינסר את הענף.',
      });
    });
  });
});
