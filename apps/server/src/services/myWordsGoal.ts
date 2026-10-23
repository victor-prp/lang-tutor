import type { MyWordsGoal } from '@lang-tutor/core/api';

import { goalOf, storedGoal } from '../domain/myWordsGoal';
import type { Logger } from '../logger';
import { authorizeEnrollment } from './access';
import { learnerDay } from './learnerDay';
import { recordMyWordsDay } from './myWordsDay';
import type { Transaction } from './transaction';

/**
 * Phase 73 (spec D1, D4). The My words goal of one course, its owner's alone. A change rewrites
 * today's row when there is one, so the day shows the goal in force; days past keep theirs.
 */
export function createMyWordsGoalService({
  transaction,
  logger,
  now,
}: {
  transaction: Transaction;
  logger: Logger;
  now: () => number;
}) {
  return {
    /** The goal in force: the default (3) when never set, null when off. */
    goal: (actorUserId: string, enrollmentId: string): Promise<MyWordsGoal> =>
      transaction(async (repos) => {
        await authorizeEnrollment(repos, logger, { actorUserId, enrollmentId, permission: 'my_words_goal.manage' });
        return { goal: goalOf(await repos.enrollment.findMyWordsGoal(enrollmentId)) };
      }),

    /** Replaces the goal; the default is stored as null so the learner keeps following it. Answers
     *  what it stored. */
    putGoal: (actorUserId: string, enrollmentId: string, input: MyWordsGoal): Promise<MyWordsGoal> =>
      transaction(async (repos) => {
        const enrolled = await authorizeEnrollment(repos, logger, {
          actorUserId,
          enrollmentId,
          permission: 'my_words_goal.manage',
        });
        await repos.enrollment.setMyWordsGoal(enrollmentId, storedGoal(input.goal));
        const day = await learnerDay(repos, enrolled.user_id, now());
        if (await repos.myWordsDays.find(enrollmentId, day)) {
          await recordMyWordsDay(repos, logger, { enrollmentId, day, sessionId: null, reason: 'goal_changed' });
        }
        return { goal: goalOf(await repos.enrollment.findMyWordsGoal(enrollmentId)) };
      }),
  };
}

export type MyWordsGoalService = ReturnType<typeof createMyWordsGoalService>;
