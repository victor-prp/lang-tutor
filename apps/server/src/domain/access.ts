/**
 * Phase 28 (spec D6, ADR 0008). Who may do what to an enrollment.
 *
 * A grant gives its grantee a ROLE on one enrollment; a role names a set of
 * PERMISSIONS, here and nowhere else. A later permission (tutors read progress)
 * is one entry in PERMISSIONS and one in the role's list, plus a call to
 * services/access.ts authorize() in the use case that needs it: no migration, and
 * no grant changes. The owner may do anything with their own list.
 *
 * Phase 29 (spec D13, ADR 0009). The actor is the signed-in user, so this is a
 * security boundary. Every use case that touches a learner's data asks it: the
 * three permissions added then (reading the list, practising, photo imports)
 * are in no role, so only the owner holds them.
 *
 * Pure (ADR 0001 R3).
 */

export const PERMISSIONS = [
  'vocabulary.add',
  'vocabulary.remove',
  'vocabulary.read',
  'session.practice',
  'photo_import.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ['tutor'] as const;
export type Role = (typeof ROLES)[number];

/** The one role this phase grants. Everything outside this file and the schema
 *  names it through this constant (ADR 0008 R3). */
export const TUTOR: Role = 'tutor';

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  tutor: ['vocabulary.add'],
};

/** What the rule needs to know about a grant, whatever shape it was read in. */
export type GrantView = { ownerUserId: string; granteeUserId: string; role: string; accepted: boolean };

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** The owner may do anything; anyone else needs an ACCEPTED grant of their own
 *  whose role includes the permission. A pending grant allows nothing. */
export function may(
  actorUserId: string,
  ownerUserId: string,
  grant: GrantView | null,
  permission: Permission,
): boolean {
  if (actorUserId === ownerUserId) return true;
  if (!grant || !grant.accepted || grant.granteeUserId !== actorUserId) return false;
  if (grant.ownerUserId !== ownerUserId) return false;
  return isRole(grant.role) && ROLE_PERMISSIONS[grant.role].includes(permission);
}

/** An invite is the list owner's to accept or decline. */
export function mayAnswerInvite(actorUserId: string, grant: GrantView): boolean {
  return actorUserId === grant.ownerUserId;
}

/** Either party may end a grant: the owner declines or ends it, the grantee
 *  cancels an invite or stops (spec D4). */
export function mayEndGrant(actorUserId: string, grant: GrantView): boolean {
  return actorUserId === grant.ownerUserId || actorUserId === grant.granteeUserId;
}

/** A wire Grant (packages/core GrantSchema) as the rule sees it. Structural, so
 *  domain/ needs nothing but the shape. */
export function grantViewOf(grant: {
  owner: { id: string };
  grantee: { id: string };
  role: string;
  status: string;
}): GrantView {
  return {
    ownerUserId: grant.owner.id,
    granteeUserId: grant.grantee.id,
    role: grant.role,
    accepted: grant.status === 'accepted',
  };
}
