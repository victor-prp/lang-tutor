import type { Question } from '@lang-tutor/core/api';
import { and, asc, eq, isNull, or } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { questions, termVariants, type QuestionOption } from '../db/schema';

/** Options as authored, ordered by their canonical position. */
export function canonicalOptions(options: QuestionOption[]): QuestionOption[] {
  return [...options].sort((a, b) => a.position - b.position);
}

/**
 * Turns a question row into the API's `Question`. `order` is a session's
 * `option_order`; without it the options come back in canonical order.
 */
export function questionFrom(
  row: { id: string; options: QuestionOption[]; form: string; termId: string },
  order: number[] | null,
): Question {
  const canonical = canonicalOptions(row.options);
  const shown = order ? order.map((position) => canonical[position]) : canonical;
  return {
    id: row.id,
    type: 'multiple_choice',
    vocab_term_id: row.termId,
    question: row.form,
    options: shown.map((option) => option.text),
    correct_option: shown.findIndex((option) => option.is_correct),
  };
}

export function createQuestionRepo(tx: Tx) {
  return {
    /**
     * The pool a session draws from: shared questions plus any belonging to
     * this learner. Phase 4 only ever seeds shared ones, but the `user_id`
     * branch is here from day one so a later phase adds rows, not a migration.
     */
    loadQuestionPool: async (
      targetLanguage: string,
      userLanguageCode: string,
      userId: string,
    ): Promise<Question[]> => {
      const rows = await tx
        .select({
          id: questions.id,
          options: questions.options,
          form: termVariants.form,
          termId: termVariants.termId,
        })
        .from(questions)
        .innerJoin(termVariants, eq(termVariants.id, questions.promptVariantId))
        .where(
          and(
            or(isNull(questions.userId), eq(questions.userId, userId)),
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
  };
}

export type QuestionRepo = ReturnType<typeof createQuestionRepo>;
export type CreateQuestionRepo = (tx: Tx) => QuestionRepo;
