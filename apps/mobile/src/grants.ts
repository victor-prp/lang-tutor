import type { Enrollment, Grant, GrantList } from '@lang-tutor/core/api';

import { ApiError } from '@/api/client';
import { strings } from '@/strings';

/** Phase 28. What an account holds before its grants are read, and after sign-out. */
export const NO_GRANTS: GrantList = { tutors: [], students: [] };

/** Invites waiting for this account, as the student, to answer. */
export const pendingInvites = (grants: GrantList): Grant[] => grants.tutors.filter((g) => g.status === 'pending');

/** This account's tutors, as the student. */
export const myTutors = (grants: GrantList): Grant[] => grants.tutors.filter((g) => g.status === 'accepted');

/** This account's students, as the tutor, pending ones included. */
export const myStudents = (grants: GrantList): Grant[] => grants.students;

/** The accepted student grant the words screen opens on, or undefined: the app
 *  never offers a tutor a list it may not add to (spec D14). */
export const studentGrant = (grants: GrantList, grantId: string): Grant | undefined =>
  grants.students.find((g) => g.id === grantId && g.status === 'accepted');

/** Spec D13. Only an account with no enrollment and no grant either way is sent
 *  to choose a language; it can also choose to teach there. */
export const needsEnrollScreen = (enrollments: Enrollment[], grants: GrantList): boolean =>
  enrollments.length === 0 && grants.tutors.length === 0 && grants.students.length === 0;

/** Usernames are lowercase ASCII on the server; a typed "Victor " means victor. */
export const normalizeUsername = (typed: string): string => typed.trim().toLowerCase();

export function inviteErrorMessage(error: unknown, username: string, language: string): string {
  if (error instanceof ApiError) {
    // 400: the name fails the server's username rule, so no such user can exist.
    if (error.status === 404 || error.status === 400) return strings.inviteUserNotFound;
    if (error.code === 'not_learning') return strings.inviteNotLearning(username, language);
    if (error.code === 'own_list') return strings.inviteOwnList;
    if (error.code === 'grant_exists') return strings.inviteExists;
  }
  return strings.inviteFailed;
}
