import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { GrantExists } from '../../../src/errors';
import { createGrantRepo } from '../../../src/repo/grants';
import { enrollmentOf, seedEnrollment, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;
const E = enrollmentOf('u_student'); // English
const RU = 'e_student_ru';

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_student');
  await seedUser(t.db, 'u_tutor');
  await seedEnrollment(t.db, { id: RU, userId: 'u_student', targetLanguage: 'ru' });
});
afterEach(async () => {
  await t.close();
});

const repo = <T>(fn: (r: ReturnType<typeof createGrantRepo>) => Promise<T>) =>
  withTx(t.db, (tx) => fn(createGrantRepo(tx)));

const invite = (enrollmentId = E) =>
  repo((r) => r.insertGrant({ enrollmentId, ownerUserId: 'u_student', granteeUserId: 'u_tutor', role: 'tutor' }));

describe('grants repository', () => {
  it('inserts a pending grant and returns it in wire shape', async () => {
    const grant = await invite();
    expect(grant).toEqual({
      id: expect.any(String),
      role: 'tutor',
      status: 'pending',
      enrollment: { id: E, source_language: 'he', target_language: 'en' },
      owner: { id: 'u_student', username: 'u_student', display_name: 'test u_student' },
      grantee: { id: 'u_tutor', username: 'u_tutor', display_name: 'test u_tutor' },
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      accepted_at: null,
    });
    expect(await repo((r) => r.findGrant(grant.id))).toEqual(grant);
  });

  it('throws GrantExists for a second grant to the same person on the same list', async () => {
    await invite();
    await expect(invite()).rejects.toBeInstanceOf(GrantExists);
  });

  it('allows the same tutor on another of the student’s lists', async () => {
    await invite();
    await expect(invite(RU)).resolves.toMatchObject({ enrollment: { id: RU } });
  });

  it('accepts once: a second accept keeps the first time', async () => {
    const grant = await invite();
    await repo((r) => r.acceptGrant(grant.id));
    const first = await repo((r) => r.findGrant(grant.id));
    await repo((r) => r.acceptGrant(grant.id));
    const second = await repo((r) => r.findGrant(grant.id));
    expect(first).toMatchObject({ status: 'accepted', accepted_at: expect.stringMatching(/^\d{4}-/) });
    expect(second!.accepted_at).toBe(first!.accepted_at);
  });

  it('finds the view the check needs, and null when there is no grant', async () => {
    const grant = await invite();
    expect(await repo((r) => r.findGrantFor({ enrollmentId: E, granteeUserId: 'u_tutor' }))).toEqual({
      ownerUserId: 'u_student',
      granteeUserId: 'u_tutor',
      role: 'tutor',
      accepted: false,
    });
    await repo((r) => r.acceptGrant(grant.id));
    expect(await repo((r) => r.findGrantFor({ enrollmentId: E, granteeUserId: 'u_tutor' }))).toMatchObject({
      accepted: true,
    });
    expect(await repo((r) => r.findGrantFor({ enrollmentId: RU, granteeUserId: 'u_tutor' }))).toBeNull();
  });

  it('lists grants both ways, newest first', async () => {
    const older = await invite();
    await t.db.execute(sql`update enrollment_grants set created_at = now() - interval '1 hour' where id = ${older.id}`);
    const newer = await invite(RU);
    expect((await repo((r) => r.listForOwner('u_student'))).map((g) => g.id)).toEqual([newer.id, older.id]);
    expect((await repo((r) => r.listForGrantee('u_tutor'))).map((g) => g.id)).toEqual([newer.id, older.id]);
    expect(await repo((r) => r.listForOwner('u_tutor'))).toEqual([]);
    expect(await repo((r) => r.listForGrantee('u_student'))).toEqual([]);
  });

  it('deletes a grant, and deleting it again is a no-op', async () => {
    const grant = await invite();
    await repo((r) => r.deleteGrant(grant.id));
    await repo((r) => r.deleteGrant(grant.id));
    expect(await repo((r) => r.findGrant(grant.id))).toBeUndefined();
  });
});
