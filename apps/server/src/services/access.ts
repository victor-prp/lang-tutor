import type { Enrollment } from '@lang-tutor/core/api';

import { may, type Permission } from '../domain/access';
import { AccessDenied, EnrollmentNotFound } from '../errors';
import type { Logger } from '../logger';
import type { Repos } from './transaction';

/**
 * ADR 0008's one check (spec D8). Call it inside the use case's transaction,
 * after the enrollment is loaded and before anything is written. Answers who
 * the actor is to this list, for the log; throws AccessDenied when the rule in
 * domain/access.ts says no.
 *
 * The owner needs no read: may() with no grant already answers for them.
 */
export async function authorize(
  repos: Repos,
  logger: Logger,
  input: { actorUserId: string; enrollment: Enrollment; permission: Permission },
): Promise<'owner' | 'grantee'> {
  const { actorUserId, enrollment, permission } = input;
  if (may(actorUserId, enrollment.user_id, null, permission)) return 'owner';
  const grant = await repos.grant.findGrantFor({ enrollmentId: enrollment.id, granteeUserId: actorUserId });
  if (may(actorUserId, enrollment.user_id, grant, permission)) return 'grantee';
  logger.info({
    event: 'access_denied',
    actor_user_id: actorUserId,
    enrollment_id: enrollment.id,
    permission,
  });
  throw new AccessDenied(actorUserId, enrollment.id, permission);
}

/**
 * Phase 29 (ADR 0009 R7). The enrollment by id, or EnrollmentNotFound; then
 * the one check. For use cases addressed by an enrollment id.
 */
export async function authorizeEnrollment(
  repos: Repos,
  logger: Logger,
  input: { actorUserId: string; enrollmentId: string; permission: Permission },
): Promise<Enrollment> {
  const enrollment = await repos.enrollment.findById(input.enrollmentId);
  if (!enrollment) throw new EnrollmentNotFound(input.enrollmentId);
  await authorize(repos, logger, { actorUserId: input.actorUserId, enrollment, permission: input.permission });
  return enrollment;
}
