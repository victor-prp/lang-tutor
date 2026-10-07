import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { insertLexeme } from '../../support/dictRows';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_student'); // enrolled in English as e_u_student
  await seedUser(t.db, 'u_tutor');
});
afterEach(async () => {
  await t.close();
});

const violating = (constraint: string) =>
  expect.objectContaining({
    cause: expect.objectContaining({ message: expect.stringContaining(constraint) }),
  });

const grant = (over: { owner?: string; grantee?: string; enrollment?: string; role?: string } = {}) =>
  t.db.execute(sql`
    insert into enrollment_grants (enrollment_id, owner_user_id, grantee_user_id, role)
    values (${over.enrollment ?? enrollmentOf('u_student')}, ${over.owner ?? 'u_student'},
            ${over.grantee ?? 'u_tutor'}, ${over.role ?? 'tutor'})`);

describe('enrollment_grants', () => {
  it('accepts a pending tutor grant with a generated id', async () => {
    await grant();
    const rows = await t.db.execute<{ id: string; accepted_at: string | null }>(
      sql`select id, accepted_at from enrollment_grants`,
    );
    expect(rows.rows).toEqual([{ id: expect.any(String), accepted_at: null }]);
  });

  it('refuses a grant to the owner', async () => {
    await expect(grant({ grantee: 'u_student' })).rejects.toEqual(violating('enrollment_grants_not_owner'));
  });

  it('refuses an owner who does not own the enrollment', async () => {
    await expect(grant({ owner: 'u_tutor', grantee: 'u_student' })).rejects.toEqual(
      violating('enrollment_grants_enrollment_fk'),
    );
  });

  it('refuses a second grant to the same person on the same list', async () => {
    await grant();
    await expect(grant()).rejects.toEqual(violating('enrollment_grants_enrollment_grantee_key'));
  });

  it('refuses an unknown role', async () => {
    await expect(grant({ role: 'parent' })).rejects.toEqual(violating('enrollment_grants_role_known'));
  });
});

describe('vocabulary_entries.added_by_user_id', () => {
  it('is required, and must name a user', async () => {
    const kite = await insertLexeme(t.db, {
      lemma: 'kite',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'toy' }],
      variants: [
        {
          form: 'kite',
          kind: 'word',
          entryRank: 0,
          translations: [{ senseCode: 'toy', rank: 0, translation: 'עפיפון', exampleSource: null, exampleTarget: null }],
        },
      ],
    });
    const insert = (addedBy: string | null) =>
      t.db.execute(sql`
        insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, lemma, variant_id, added_by_user_id)
        values (${enrollmentOf('u_student')}, ${kite.senseIds[0]}, ${kite.lexemeId}, 'kite', ${kite.variantIds[0]}, ${addedBy})`);
    await expect(insert(null)).rejects.toEqual(violating('added_by_user_id'));
    await expect(insert('u_nobody')).rejects.toEqual(violating('vocabulary_entries_added_by_fk'));
    await insert('u_tutor');
  });
});
