import { describe, expect, it } from '@jest/globals';
import type { Enrollment, Grant, GrantList } from '@lang-tutor/core/api';

import { ApiError } from '@/api/client';
import {
  NO_GRANTS,
  inviteErrorMessage,
  myStudents,
  myTutors,
  needsEnrollScreen,
  normalizeUsername,
  pendingInvites,
  studentGrant,
} from '@/grants';
import { strings } from '@/strings';

const grant = (over: Partial<Grant> & { id: string }): Grant => ({
  role: 'tutor',
  status: 'pending',
  enrollment: { id: 'e1', source_language: 'he', target_language: 'it' },
  owner: { id: 'u_student', username: 'victor', display_name: 'ויקטור' },
  grantee: { id: 'u_tutor', username: 'rina', display_name: 'רינה' },
  created_at: '2026-10-07T10:00:00.000Z',
  accepted_at: null,
  ...over,
});
const enrollment: Enrollment = {
  id: 'e1',
  user_id: 'u_student',
  source_language: 'he',
  target_language: 'it',
  created_at: '2026-10-01T00:00:00.000Z',
};

describe('the student side', () => {
  const list: GrantList = {
    tutors: [grant({ id: 'g1' }), grant({ id: 'g2', status: 'accepted', accepted_at: '2026-10-07T11:00:00.000Z' })],
    students: [],
  };
  it('splits invites to answer from accepted tutors', () => {
    expect(pendingInvites(list).map((g) => g.id)).toEqual(['g1']);
    expect(myTutors(list).map((g) => g.id)).toEqual(['g2']);
  });
});

describe('the tutor side', () => {
  const list: GrantList = {
    tutors: [],
    students: [grant({ id: 'g3' }), grant({ id: 'g4', status: 'accepted', accepted_at: '2026-10-07T11:00:00.000Z' })],
  };
  it('lists every student, pending ones included', () => {
    expect(myStudents(list).map((g) => g.id)).toEqual(['g3', 'g4']);
  });
  it('opens the words screen for an accepted student only', () => {
    expect(studentGrant(list, 'g4')?.id).toBe('g4');
    expect(studentGrant(list, 'g3')).toBeUndefined();
    expect(studentGrant(list, 'g_missing')).toBeUndefined();
  });
});

describe('needsEnrollScreen (spec D13, Review Focus 5)', () => {
  it('is only for an account with nothing at all', () => {
    expect(needsEnrollScreen([], NO_GRANTS)).toBe(true);
  });
  it('is never for a learner, grants or not', () => {
    expect(needsEnrollScreen([enrollment], NO_GRANTS)).toBe(false);
  });
  it('is not for a tutor who learns nothing, pending invite or accepted', () => {
    expect(needsEnrollScreen([], { tutors: [], students: [grant({ id: 'g1' })] })).toBe(false);
  });
});

describe('normalizeUsername (Review Focus 2)', () => {
  it('trims and lowercases what was typed', () => {
    expect(normalizeUsername('  Victor ')).toBe('victor');
  });
});

describe('inviteErrorMessage', () => {
  it.each([
    [new ApiError(404, 'user not found'), strings.inviteUserNotFound],
    [new ApiError(409, 'not_learning'), strings.inviteNotLearning('victor', 'it')],
    [new ApiError(409, 'own_list'), strings.inviteOwnList],
    [new ApiError(409, 'grant_exists'), strings.inviteExists],
    [new ApiError(500), strings.inviteFailed],
    [new Error('offline'), strings.inviteFailed],
  ])('says what went wrong for %s', (error, message) => {
    expect(inviteErrorMessage(error, 'victor', 'it')).toBe(message);
  });
});
