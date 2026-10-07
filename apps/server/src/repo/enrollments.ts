import type { Enrollment } from '@lang-tutor/core/api';
import { and, desc, eq } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { enrollments } from '../db/schema';
import { AlreadyEnrolled } from '../errors';
import { isUniqueViolation } from './pgErrors';

type EnrollmentRow = typeof enrollments.$inferSelect;

function toEnrollment(row: EnrollmentRow): Enrollment {
  return {
    id: row.id,
    user_id: row.userId,
    source_language: row.sourceLanguage,
    target_language: row.targetLanguage,
    created_at: row.createdAt.toISOString(),
  };
}

export function createEnrollmentRepo(tx: Tx) {
  return {
    /**
     * Inserts optimistically and lets UNIQUE(user_id, target_language) decide,
     * for the reason insertUser does: a check-then-insert races a double tap.
     */
    insertEnrollment: async (input: {
      userId: string;
      sourceLanguage: string;
      targetLanguage: string;
    }): Promise<Enrollment> => {
      try {
        const [row] = await tx
          .insert(enrollments)
          .values({
            userId: input.userId,
            sourceLanguage: input.sourceLanguage,
            targetLanguage: input.targetLanguage,
          })
          .returning();
        return toEnrollment(row);
      } catch (error) {
        if (isUniqueViolation(error)) throw new AlreadyEnrolled(input.userId, input.targetLanguage);
        throw error;
      }
    },

    /** Newest first: the app falls back to the newest when it remembers none. */
    listByUser: async (userId: string): Promise<Enrollment[]> =>
      (
        await tx
          .select()
          .from(enrollments)
          .where(eq(enrollments.userId, userId))
          .orderBy(desc(enrollments.createdAt), desc(enrollments.id))
      ).map(toEnrollment),

    /** Phase 28. The enrollment a tutor's invite names: UNIQUE(user_id, target_language). */
    findByUserAndTarget: async (userId: string, targetLanguage: string): Promise<Enrollment | undefined> => {
      const [row] = await tx
        .select()
        .from(enrollments)
        .where(and(eq(enrollments.userId, userId), eq(enrollments.targetLanguage, targetLanguage)));
      return row ? toEnrollment(row) : undefined;
    },

    findById: async (id: string): Promise<Enrollment | undefined> => {
      const [row] = await tx.select().from(enrollments).where(eq(enrollments.id, id));
      return row ? toEnrollment(row) : undefined;
    },
  };
}

export type EnrollmentRepo = ReturnType<typeof createEnrollmentRepo>;
