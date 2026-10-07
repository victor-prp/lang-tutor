import { describe, expect, it } from '@jest/globals';

import { PERMISSIONS, grantViewOf, isRole, may, mayAnswerInvite, mayEndGrant, type GrantView } from './access';

const OWNER = 'u_student';
const TUTOR_ID = 'u_tutor';
const STRANGER = 'u_stranger';
const accepted: GrantView = { ownerUserId: OWNER, granteeUserId: TUTOR_ID, role: 'tutor', accepted: true };
const pending: GrantView = { ...accepted, accepted: false };

describe('may', () => {
  it.each(PERMISSIONS)('lets the owner %s on their own list, with or without a grant', (permission) => {
    expect(may(OWNER, OWNER, null, permission)).toBe(true);
    expect(may(OWNER, OWNER, accepted, permission)).toBe(true);
  });

  it('lets an accepted tutor add words and nothing else', () => {
    expect(may(TUTOR_ID, OWNER, accepted, 'vocabulary.add')).toBe(true);
    expect(may(TUTOR_ID, OWNER, accepted, 'vocabulary.remove')).toBe(false);
  });

  it.each(PERMISSIONS)('refuses a pending tutor %s', (permission) => {
    expect(may(TUTOR_ID, OWNER, pending, permission)).toBe(false);
  });

  it.each(PERMISSIONS)('refuses %s to someone holding no grant', (permission) => {
    expect(may(STRANGER, OWNER, null, permission)).toBe(false);
  });

  it("refuses an actor presenting someone else's grant", () => {
    expect(may(STRANGER, OWNER, accepted, 'vocabulary.add')).toBe(false);
  });

  it('refuses a role this server does not know', () => {
    expect(may(TUTOR_ID, OWNER, { ...accepted, role: 'parent' }, 'vocabulary.add')).toBe(false);
  });
});

describe('isRole', () => {
  it('knows tutor and nothing else', () => {
    expect(isRole('tutor')).toBe(true);
    expect(isRole('parent')).toBe(false);
  });
});

describe('mayAnswerInvite', () => {
  it('is the owner only', () => {
    expect(mayAnswerInvite(OWNER, pending)).toBe(true);
    expect(mayAnswerInvite(TUTOR_ID, pending)).toBe(false);
    expect(mayAnswerInvite(STRANGER, pending)).toBe(false);
  });
});

describe('mayEndGrant', () => {
  it('is either party, and nobody else', () => {
    expect(mayEndGrant(OWNER, accepted)).toBe(true);
    expect(mayEndGrant(TUTOR_ID, accepted)).toBe(true);
    expect(mayEndGrant(STRANGER, accepted)).toBe(false);
  });
});

describe('grantViewOf', () => {
  it('reads the parties, the role and acceptance off a wire grant', () => {
    expect(
      grantViewOf({ owner: { id: OWNER }, grantee: { id: TUTOR_ID }, role: 'tutor', status: 'pending' }),
    ).toEqual(pending);
  });
});
