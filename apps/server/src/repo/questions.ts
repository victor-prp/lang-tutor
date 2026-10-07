import type { Question } from '@lang-tutor/core/api';
import type { QuestionType } from '@lang-tutor/core/domain';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import type { GenerationContext } from '../domain/distractors';
import { dictLexemes, dictVariants, questions, type QuestionOption } from '../db/schema';

/** Options as authored, ordered by their canonical position. */
export function canonicalOptions(options: QuestionOption[]): QuestionOption[] {
  return [...options].sort((a, b) => a.position - b.position);
}

/** A question row with what its variant and lexeme add: everything any of the
 *  three types is built from. */
export type QuestionRow = {
  id: string;
  type: string;
  prompt: string | null;
  options: QuestionOption[] | null;
  alternatives: string[] | null;
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
  form: dictVariants.form,
  lemma: dictLexemes.lemma,
  partOfSpeech: dictLexemes.partOfSpeech,
  lexemeId: dictVariants.lexemeId,
};

/**
 * Turns a question row into the API's `Question`. `order` is a session's
 * `option_order`; without it, or for a typed card (whose order is `{}`), the
 * options come back in canonical order.
 *
 * Phase 23: today's card asks the variant's form; the reversed and typed cards
 * ask the stored Hebrew prompt. A typed card's answer is the variant's form and
 * is never stored twice.
 */
export function questionFrom(row: QuestionRow, order: number[] | null): Question {
  const base = { id: row.id, vocab_term_id: row.lexemeId };
  if (row.type === 'typed_translation') {
    return {
      ...base,
      type: 'typed_translation',
      question: row.prompt!,
      part_of_speech: row.partOfSpeech,
      answer: row.form,
      lemma: row.lemma,
      alternatives: row.alternatives ?? [],
    };
  }
  const canonical = canonicalOptions(row.options!);
  const shown = order && order.length > 0 ? order.map((position) => canonical[position]) : canonical;
  const choice = {
    options: shown.map((option) => option.text),
    correct_option: shown.findIndex((option) => option.is_correct),
  };
  return row.type === 'reverse_choice'
    ? { ...base, type: 'reverse_choice', question: row.prompt!, part_of_speech: row.partOfSpeech, ...choice }
    : { ...base, type: 'multiple_choice', question: row.form, ...choice };
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
          })),
        )
        .returning({ id: questions.id });
      return rows.map((row, index) => {
        const question = input.questions[index];
        return questionFrom(
          {
            id: row.id,
            type: question.type,
            prompt: question.prompt,
            options: question.options,
            alternatives: question.alternatives,
            form: question.form,
            lemma: question.lemma,
            partOfSpeech: question.partOfSpeech,
            lexemeId: question.lexemeId,
          },
          null,
        );
      });
    },
  };
}

export type QuestionRepo = ReturnType<typeof createQuestionRepo>;
export type CreateQuestionRepo = (tx: Tx) => QuestionRepo;
