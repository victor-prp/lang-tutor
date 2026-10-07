import type { CreateGrantRequest, Grant, GrantList } from '@lang-tutor/core/api';

import { TUTOR, grantViewOf, mayAnswerInvite, mayEndGrant } from '../domain/access';
import { AccessDenied, GrantNotFound, NotLearning, OwnList, UserNotFound } from '../errors';
import type { Logger } from '../logger';
import type { Transaction } from './transaction';

/**
 * Phase 28 (spec D9). Inviting, listing, accepting and ending access grants. One
 * transaction per use case (ADR 0001 R8): each reads what it checks and writes in
 * the same one. The actor is asserted (ADR 0008 R5).
 */
export function createGrantService({ transaction, logger }: { transaction: Transaction; logger: Logger }) {
  const denied = (actorUserId: string, grant: Grant, action: string) => {
    logger.info({ event: 'access_denied', actor_user_id: actorUserId, enrollment_id: grant.enrollment.id, permission: action });
    return new AccessDenied(actorUserId, grant.enrollment.id, action);
  };

  return {
    invite: async (actorUserId: string, input: CreateGrantRequest): Promise<Grant> => {
      const grant = await transaction(async (repos) => {
        const student = await repos.user.findByUsername(input.username);
        if (!student) throw new UserNotFound(input.username);
        if (student.id === actorUserId) throw new OwnList(actorUserId);
        const enrollment = await repos.enrollment.findByUserAndTarget(student.id, input.target_language);
        if (!enrollment) throw new NotLearning(student.id, input.target_language);
        return repos.grant.insertGrant({
          enrollmentId: enrollment.id,
          ownerUserId: student.id,
          granteeUserId: actorUserId,
          role: TUTOR,
        });
      });
      logger.info({ event: 'grant_invited', grant_id: grant.id, role: grant.role, enrollment_id: grant.enrollment.id });
      return grant;
    },

    list: (actorUserId: string): Promise<GrantList> =>
      transaction(async (repos) => ({
        tutors: await repos.grant.listForOwner(actorUserId),
        students: await repos.grant.listForGrantee(actorUserId),
      })),

    /** Idempotent: accepting an accepted grant answers it unchanged. */
    accept: async (actorUserId: string, grantId: string): Promise<Grant> => {
      const accepted = await transaction(async (repos) => {
        const grant = await repos.grant.findGrant(grantId);
        if (!grant) throw new GrantNotFound(grantId);
        if (!mayAnswerInvite(actorUserId, grantViewOf(grant))) throw denied(actorUserId, grant, 'grant.accept');
        await repos.grant.acceptGrant(grantId);
        return (await repos.grant.findGrant(grantId))!;
      });
      logger.info({ event: 'grant_accepted', grant_id: accepted.id, role: accepted.role });
      return accepted;
    },

    /** Declining, cancelling and ending are one delete (spec D4). Idempotent: a
     *  grant that is already gone is not an error, as unsave is not. */
    end: async (actorUserId: string, grantId: string): Promise<void> => {
      const ended = await transaction(async (repos) => {
        const grant = await repos.grant.findGrant(grantId);
        if (!grant) return null;
        const view = grantViewOf(grant);
        if (!mayEndGrant(actorUserId, view)) throw denied(actorUserId, grant, 'grant.end');
        await repos.grant.deleteGrant(grantId);
        return { grant, by: actorUserId === view.ownerUserId ? 'owner' : 'grantee' };
      });
      if (ended) {
        logger.info({
          event: 'grant_ended',
          grant_id: ended.grant.id,
          role: ended.grant.role,
          by: ended.by,
          was: ended.grant.status,
        });
      }
    },
  };
}

export type GrantService = ReturnType<typeof createGrantService>;
