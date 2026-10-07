import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { QuestionType } from '@lang-tutor/core/domain';

import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';
import { content, optionsFor } from '../../../src/db/content';
import { dictSenses, dictVariants } from '../../../src/db/schema';
import { optionsFor as generatedOptions, type QuestionOption } from '../../../src/domain/distractors';
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
      { senseId: run.senseIds[0], variantId: run.variantId, lexemeId: run.lexemeId, form: 'sprint', lemma: 'sprint', partOfSpeech: 'noun', translation: 'ריצה', example: null, exampleTranslation: null },
      { senseId: book.senseIds[0], variantId: book.variantId, lexemeId: book.lexemeId, form: 'tome', lemma: 'tome', partOfSpeech: 'noun', translation: 'ספר', example: null, exampleTranslation: null },
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
    tiles: string[] | null;
  }[] = [
    { label: 'a typed question with options', type: 'typed_translation', prompt: 'ספר', options: generatedOptions('tome', ['a', 'b', 'c']), alternatives: [], tiles: null },
    { label: 'a typed question without a prompt', type: 'typed_translation', prompt: null, options: null, alternatives: [], tiles: null },
    { label: 'a typed question with six alternatives', type: 'typed_translation', prompt: 'ספר', options: null, alternatives: ['a', 'b', 'c', 'd', 'e', 'f'], tiles: null },
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
      asked.push({ senseId: saved.senseIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation });
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
      { senseId: saved.senseIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: 'to book', lemma: 'reserve', translation: 'להזמין' },
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
    senseId: word.senseIds[0],
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
          { senseId: word.senseIds[0], variantId: word.variantId },
          { senseId: bare.senseIds[0], variantId: bare.variantId },
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

    it('returns, per sense, newest first, only this enrollment, only the two types, at most limit', async () => {
      await seedUser(t.db, 'u_2');
      const word = await savedWord();
      const enrollmentId = enrollmentOf('u_1');
      await ask(word, enrollmentId, 'u_1', [typedWith(1)]);
      await ask(word, enrollmentId, 'u_1', [translateWith(1)]);
      await ask(word, enrollmentId, 'u_1', [typedWith(2)]);
      // A cloze_choice shows the saved example, which is not a written sentence.
      await ask(word, enrollmentId, 'u_1', [{ type: 'cloze_choice', options: generatedOptions('parlavamo', ['a', 'b', 'c']), sentence: 'Ieri parlavamo 9.' }]);
      await ask(word, enrollmentId, 'u_1', [typedWith(3)]);
      // Another learner's question for the same sense.
      await ask(word, enrollmentOf('u_2'), 'u_2', [typedWith(7)]);
      await ask(word, enrollmentId, 'u_1', [translateWith(2)]);

      const read = (limit: number, senseIds = [word.senseIds[0], 'other']) =>
        withTx(t.db, (tx) => createQuestionRepo(tx).findRecentSentences({ enrollmentId, senseIds, limit }));

      const recent = await read(2);
      expect(recent.get(word.senseIds[0])).toEqual({
        cloze: ['Ieri parlavamo 3.', 'Ieri parlavamo 2.'],
        // The Hebrew sentence asked, not the reference that follows the answer.
        translate: ['דיברנו 2.', 'דיברנו 1.'],
      });
      expect((await read(10)).get(word.senseIds[0])!.cloze).toEqual(['Ieri parlavamo 3.', 'Ieri parlavamo 2.', 'Ieri parlavamo 1.']);
      // A sense with none has no entry; no senses is an empty map.
      expect(recent.has('other')).toBe(false);
      expect((await read(2, [])).size).toBe(0);
    });
  });
});
