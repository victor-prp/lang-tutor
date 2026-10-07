import type { MatchingQuestion, Question } from '@lang-tutor/core/api';
import type { QuestionType } from '@lang-tutor/core/domain';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import type { GenerationContext } from '../domain/distractors';
import { dictLexemes, dictVariants, questions, type QuestionOption } from '../db/schema';

/** Options as authored, ordered by their canonical position. */
export function canonicalOptions(options: QuestionOption[]): QuestionOption[] {
  return [...options].sort((a, b) => a.position - b.position);
}

/** A question row with what its variant and lexeme add: everything any
 *  question type is built from. */
export type QuestionRow = {
  id: string;
  type: string;
  prompt: string | null;
  options: QuestionOption[] | null;
  alternatives: string[] | null;
  tiles: string[] | null;
  form: string;
  lemma: string;
  partOfSpeech: string;
  lexemeId: string;
};

/** The columns a QuestionRow reads, for every select that builds one. Joins
 *  dict_variants and dict_lexemes. */
export const questionColumns = {
  id: questions.id,
  type: questions.type,
  prompt: questions.prompt,
  options: questions.options,
  alternatives: questions.alternatives,
  tiles: questions.tiles,
  form: dictVariants.form,
  lemma: dictLexemes.lemma,
  partOfSpeech: dictLexemes.partOfSpeech,
  lexemeId: dictVariants.lexemeId,
};

/**
 * Turns a question row into the API's `Question`. `order` is a session's
 * `option_order`; without it, or for a text card (whose order is `{}`), the
 * options come back in canonical order.
 *
 * Phase 23: today's card asks the variant's form; the reversed and typed cards
 * ask the stored Hebrew prompt. Phase 24: a listening card and a board word ask
 * the form too (spoken, or beside its meanings); a dictation speaks the form
 * and keeps the Hebrew as its meaning; a tiles card asks the Hebrew. Phase 25: a
 * read-aloud card shows the form and keeps the Hebrew as its meaning; say the
 * translation asks the Hebrew, as the typed card does. A matching row comes back
 * as a board of one, which withBoards joins.
 */
export function questionFrom(row: QuestionRow, order: number[] | null): Question {
  const base = { id: row.id, vocab_term_id: row.lexemeId };
  switch (row.type) {
    case 'typed_translation':
      return {
        ...base,
        type: 'typed_translation',
        question: row.prompt!,
        part_of_speech: row.partOfSpeech,
        answer: row.form,
        lemma: row.lemma,
        alternatives: row.alternatives ?? [],
      };
    case 'dictation':
      return { ...base, type: 'dictation', question: row.form, meaning: row.prompt! };
    case 'read_aloud':
      return { ...base, type: 'read_aloud', question: row.form, meaning: row.prompt! };
    case 'say_translation':
      return {
        ...base,
        type: 'say_translation',
        question: row.prompt!,
        part_of_speech: row.partOfSpeech,
        answer: row.form,
        lemma: row.lemma,
        alternatives: row.alternatives ?? [],
      };
    case 'typed_meaning':
      // Phase 27 (spec D15): the form is asked, the stored Hebrew is the meaning
      // the judge compares the answer with.
      return {
        ...base,
        type: 'typed_meaning',
        question: row.form,
        part_of_speech: row.partOfSpeech,
        meaning: row.prompt!,
      };
    case 'letter_tiles':
      return {
        ...base,
        type: 'letter_tiles',
        question: row.prompt!,
        part_of_speech: row.partOfSpeech,
        answer: row.form,
        tiles: row.tiles!,
      };
  }
  const canonical = canonicalOptions(row.options!);
  const shown = order && order.length > 0 ? order.map((position) => canonical[position]) : canonical;
  const choice = {
    options: shown.map((option) => option.text),
    correct_option: shown.findIndex((option) => option.is_correct),
  };
  switch (row.type) {
    case 'reverse_choice':
      return { ...base, type: 'reverse_choice', question: row.prompt!, part_of_speech: row.partOfSpeech, ...choice };
    case 'listen_choice':
      return { ...base, type: 'listen_choice', question: row.form, ...choice };
    case 'matching':
      return {
        ...base,
        type: 'matching',
        question: row.form,
        ...choice,
        board: { question_ids: [row.id], words: [row.form], correct_options: [choice.correct_option] },
      };
    default:
      return { ...base, type: 'multiple_choice', question: row.form, ...choice };
  }
}

/**
 * Phase 24 (spec D10). Gives each run of consecutive matching questions the
 * whole board: every word's question id, the word, and its correct option. A
 * session holds at most one board, and its words share one option order.
 */
export function withBoards(questions: readonly Question[]): Question[] {
  const result = [...questions];
  for (let start = 0; start < result.length; ) {
    let end = start;
    while (end < result.length && result[end].type === 'matching') end++;
    if (end === start) {
      start++;
      continue;
    }
    const run = result.slice(start, end) as MatchingQuestion[];
    const board = {
      question_ids: run.map((question) => question.id),
      words: run.map((question) => question.question),
      correct_options: run.map((question) => question.correct_option),
    };
    for (let i = start; i < end; i++) result[i] = { ...(result[i] as MatchingQuestion), board };
    start = end;
  }
  return result;
}

export function createQuestionRepo(tx: Tx) {
  return {
    /**
     * The seed pool: shared questions only. Phase 19 writes enrollment-owned
     * questions for list sessions, and a seed session must never draw one —
     * the per-learner branch phase 16 left here would have let it.
     */
    loadQuestionPool: async (
      targetLanguage: string,
      userLanguageCode: string,
    ): Promise<Question[]> => {
      const rows = await tx
        .select(questionColumns)
        .from(questions)
        .innerJoin(dictVariants, eq(dictVariants.id, questions.promptVariantId))
        .innerJoin(dictLexemes, eq(dictLexemes.id, dictVariants.lexemeId))
        .where(
          and(
            isNull(questions.userId),
            eq(questions.targetLanguage, targetLanguage),
            eq(questions.userLanguageCode, userLanguageCode),
          ),
        )
        // A stable pool order is what makes a seeded rng reproducible: the rng
        // draws by index, so two services sharing a seed only draw the same
        // question ids if the pool arrives in the same order both times.
        .orderBy(asc(questions.id));

      return rows.map((row) => questionFrom(row, null));
    },

    /**
     * What generation needs for each pick: the saved form, its lexeme, and that
     * form's rendering of the sense in the source language. In pick order. A
     * pick whose rows are gone (a db:reseed between request and job) is
     * dropped rather than failing the whole session.
     */
    findGenerationContext: async (input: {
      picks: { senseId: string; variantId: string }[];
      sourceLanguage: string;
    }): Promise<GenerationContext[]> => {
      if (input.picks.length === 0) return [];
      const rows = await tx.execute<{
        sense_id: string;
        variant_id: string;
        lexeme_id: string;
        form: string;
        lemma: string;
        part_of_speech: string;
        translation: string;
      }>(sql`
        SELECT tr.sense_id, tr.variant_id, l.id AS lexeme_id, v.form, l.lemma, l.part_of_speech, tr.translation
        FROM (VALUES ${sql.join(
          input.picks.map((pick) => sql`(${pick.senseId}::text, ${pick.variantId}::text)`),
          sql`, `,
        )}) AS asked(sense_id, variant_id)
        JOIN dict_var_translations tr ON tr.sense_id = asked.sense_id
                                     AND tr.variant_id = asked.variant_id
                                     AND tr.user_language_code = ${input.sourceLanguage}
        JOIN dict_variants v          ON v.id = tr.variant_id
        JOIN dict_lexemes l           ON l.id = v.lexeme_id`);
      const found = new Map(rows.rows.map((row) => [`${row.sense_id} ${row.variant_id}`, row]));
      return input.picks.flatMap((pick) => {
        const row = found.get(`${pick.senseId} ${pick.variantId}`);
        return row
          ? [
              {
                senseId: row.sense_id,
                variantId: row.variant_id,
                lexemeId: row.lexeme_id,
                form: row.form,
                lemma: row.lemma,
                partOfSpeech: row.part_of_speech,
                translation: row.translation,
              },
            ]
          : [];
      });
    },

    /**
     * Phase 27 (spec D15). What the meaning judge is shown: the asked form, its
     * lexeme, the stored meaning, and the learner's saved example for that
     * form and sense. questions.id is text, so an id that matches nothing is
     * simply no row.
     */
    findJudgeContext: async (
      questionId: string,
    ): Promise<
      | {
          form: string;
          lemma: string;
          partOfSpeech: string;
          meaning: string;
          example: string | null;
          exampleTranslation: string | null;
        }
      | undefined
    > => {
      const rows = await tx.execute<{
        form: string;
        lemma: string;
        part_of_speech: string;
        prompt: string;
        example_source: string | null;
        example_target: string | null;
      }>(sql`
        SELECT v.form, l.lemma, l.part_of_speech, q.prompt, tr.example_source, tr.example_target
        FROM questions q
        JOIN dict_variants v  ON v.id = q.prompt_variant_id
        JOIN dict_lexemes l   ON l.id = v.lexeme_id
        LEFT JOIN dict_var_translations tr ON tr.variant_id = q.prompt_variant_id
                                          AND tr.sense_id = q.sense_id
                                          AND tr.user_language_code = q.user_language_code
        WHERE q.id = ${questionId}`);
      const row = rows.rows[0];
      return row
        ? {
            form: row.form,
            lemma: row.lemma,
            partOfSpeech: row.part_of_speech,
            meaning: row.prompt,
            example: row.example_source,
            exampleTranslation: row.example_target,
          }
        : undefined;
    },

    /** One list session's questions, owned by its enrollment, each of the type
     *  the service chose (phase 23). Ids come from the database, as users.id
     *  does, so no randomness enters this layer. */
    insertGeneratedQuestions: async (input: {
      userId: string;
      enrollmentId: string;
      targetLanguage: string;
      userLanguageCode: string;
      questions: {
        senseId: string;
        variantId: string;
        form: string;
        lemma: string;
        partOfSpeech: string;
        lexemeId: string;
        type: QuestionType;
        prompt: string | null;
        options: QuestionOption[] | null;
        alternatives: string[] | null;
        tiles: string[] | null;
      }[];
    }): Promise<Question[]> => {
      if (input.questions.length === 0) return [];
      const rows = await tx
        .insert(questions)
        .values(
          input.questions.map((question) => ({
            id: sql<string>`gen_random_uuid()::text`,
            userId: input.userId,
            enrollmentId: input.enrollmentId,
            senseId: question.senseId,
            promptVariantId: question.variantId,
            targetLanguage: input.targetLanguage,
            userLanguageCode: input.userLanguageCode,
            type: question.type,
            prompt: question.prompt,
            options: question.options,
            alternatives: question.alternatives,
            tiles: question.tiles,
          })),
        )
        .returning({ id: questions.id });
      return withBoards(rows.map((row, index) => {
        const question = input.questions[index];
        return questionFrom(
          {
            id: row.id,
            type: question.type,
            prompt: question.prompt,
            options: question.options,
            alternatives: question.alternatives,
            tiles: question.tiles,
            form: question.form,
            lemma: question.lemma,
            partOfSpeech: question.partOfSpeech,
            lexemeId: question.lexemeId,
          },
          null,
        );
      }));
    },
  };
}

export type QuestionRepo = ReturnType<typeof createQuestionRepo>;
export type CreateQuestionRepo = (tx: Tx) => QuestionRepo;
