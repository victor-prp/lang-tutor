import type { CreateEnrollmentRequest, Enrollment } from '@lang-tutor/core/api';

import { UserNotFound } from '../errors';
import type { Logger } from '../logger';
import type { Transaction } from './transaction';

/**
 * Enrolling and listing. One transaction each (ADR 0001 R8): the user check and
 * the write are dependent — an enrollment for a user that does not exist is
 * wrong — so they share it.
 */
export function createEnrollmentService({
  transaction,
  logger,
}: {
  transaction: Transaction;
  logger: Logger;
}) {
  return {
    enroll: async (userId: string, input: CreateEnrollmentRequest): Promise<Enrollment> => {
      const created = await transaction(async ({ user, enrollment }) => {
        if (!(await user.findById(userId))) throw new UserNotFound(userId);
        return enrollment.insertEnrollment({
          userId,
          sourceLanguage: input.source_language,
          targetLanguage: input.target_language,
        });
      });
      logger.info({
        event: 'enrolled',
        user_id: userId,
        enrollment_id: created.id,
        source_language: created.source_language,
        target_language: created.target_language,
      });
      return created;
    },

    list: (userId: string): Promise<Enrollment[]> =>
      transaction(async ({ user, enrollment }) => {
        if (!(await user.findById(userId))) throw new UserNotFound(userId);
        return enrollment.listByUser(userId);
      }),
  };
}

export type EnrollmentService = ReturnType<typeof createEnrollmentService>;
