import type { Question } from '@lang-tutor/core/api';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import type { GenerationContext } from '../domain/distractors';
import { questions, dictVariants, type QuestionOption } from '../db/schema';

/** Options as authored, ordered by their canonical position. */
export function canonicalOptions(options: QuestionOption[]): QuestionOption[] {
  return [...options].sort((a, b) => a.position - b.position);
}

/**
 * Turns a question row into the API's `Question`. `order` is a session's
 * `option_order`; without it the options come back in canonical order.
 */
export function questionFrom(
  row: { id: string; options: QuestionOption[]; form: string; lexemeId: string },
  order: number[] | null,
): Question {
  const canonical = canonicalOptions(row.options);
  const shown = order ? order.map((position) => canonical[position]) : canonical;
  return {
    id: row.id,
    type: 'multiple_choice',
    vocab_term_id: row.lexemeId,
    question: row.form,
    options: shown.map((option) => option.text),
    correct_option: shown.findIndex((option) => option.is_correct),
  };
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
        .select({
          id: questions.id,
          options: questions.options,
          form: dictVariants.form,
          lexemeId: dictVariants.lexemeId,
        })
        .from(questions)
        .innerJoin(dictVariants, eq(dictVariants.id, questions.promptVariantId))
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

    /** One list session's questions, owned by its enrollment. Ids come from the
     *  database, as users.id does, so no randomness enters this layer. */
    insertGeneratedQuestions: async (input: {
      userId: string;
      enrollmentId: string;
      targetLanguage: string;
      userLanguageCode: string;
      questions: {
        senseId: string;
        variantId: string;
        form: string;
        lexemeId: string;
        options: QuestionOption[];
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
            type: 'multiple_choice',
            options: question.options,
          })),
        )
        .returning({ id: questions.id });
      return rows.map((row, index) =>
        questionFrom(
          {
            id: row.id,
            options: input.questions[index].options,
            form: input.questions[index].form,
            lexemeId: input.questions[index].lexemeId,
          },
          null,
        ),
      );
    },
  };
}

export type QuestionRepo = ReturnType<typeof createQuestionRepo>;
export type CreateQuestionRepo = (tx: Tx) => QuestionRepo;
