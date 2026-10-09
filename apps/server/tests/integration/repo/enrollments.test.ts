import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { AlreadyEnrolled } from '../../../src/errors';
import { createEnrollmentRepo } from '../../../src/repo/enrollments';
import { seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  // seedUser enrolls u_1 in English; these tests add Russian on top.
  await seedUser(t.db, 'u_1');
  await seedUser(t.db, 'u_2');
});
afterEach(async () => {
  await t.close();
});

const repo = <T>(fn: (r: ReturnType<typeof createEnrollmentRepo>) => Promise<T>) =>
  withTx(t.db, (tx) => fn(createEnrollmentRepo(tx)));

describe('enrollments repository', () => {
  it('inserts an enrollment and returns it in wire shape', async () => {
    const created = await repo((r) =>
      r.insertEnrollment({ userId: 'u_1', sourceLanguage: 'he', targetLanguage: 'ru' }),
    );
    expect(created).toEqual({
      id: expect.any(String),
      user_id: 'u_1',
      source_language: 'he',
      target_language: 'ru',
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it('holds an English and a Russian enrollment for one learner, newest first', async () => {
    const ru = await repo((r) =>
      r.insertEnrollment({ userId: 'u_1', sourceLanguage: 'he', targetLanguage: 'ru' }),
    );
    const list = await repo((r) => r.listByUser('u_1'));
    expect(list.map((e) => e.target_language)).toEqual(['ru', 'en']);
    expect(list[0].id).toBe(ru.id);
  });

  it('accepts an Italian enrollment at the database', async () => {
    const created = await repo((r) =>
      r.insertEnrollment({ userId: 'u_1', sourceLanguage: 'he', targetLanguage: 'it' }),
    );
    expect(created.target_language).toBe('it');
  });

  it('refuses a second enrollment in the same target', async () => {
    await expect(
      repo((r) => r.insertEnrollment({ userId: 'u_1', sourceLanguage: 'he', targetLanguage: 'en' })),
    ).rejects.toBeInstanceOf(AlreadyEnrolled);
  });

  it('finds an enrollment by its learner and target, and nothing for another target', async () => {
    const ru = await repo((r) => r.insertEnrollment({ userId: 'u_1', sourceLanguage: 'he', targetLanguage: 'ru' }));
    expect(await repo((r) => r.findByUserAndTarget('u_1', 'ru'))).toEqual(ru);
    expect(await repo((r) => r.findByUserAndTarget('u_1', 'it'))).toBeUndefined();
    expect(await repo((r) => r.findByUserAndTarget('u_2', 'ru'))).toBeUndefined();
  });

  it('finds by id, and answers undefined for an unknown id', async () => {
    const [first] = await repo((r) => r.listByUser('u_2'));
    expect(await repo((r) => r.findById(first.id))).toEqual(first);
    expect(await repo((r) => r.findById('e_nobody'))).toBeUndefined();
  });

  it('rejects an unknown language and a same-language pair at the database', async () => {
    await expect(
      t.db.execute(sql`insert into enrollments (user_id, source_language, target_language) values ('u_2', 'he', 'fr')`),
    ).rejects.toThrow();
    await expect(
      t.db.execute(sql`insert into enrollments (user_id, source_language, target_language) values ('u_2', 'he', 'he')`),
    ).rejects.toThrow();
  });

  it('rejects a session whose user does not own the enrollment', async () => {
    const [ofU2] = await repo((r) => r.listByUser('u_2'));
    await expect(
      t.db.execute(
        sql`insert into sessions (user_id, enrollment_id, status, source)
            values ('u_1', ${ofU2.id}, 'skipped', 'seed')`,
      ),
    ).rejects.toMatchObject({ cause: { code: '23503', constraint: 'sessions_enrollment_fk' } });
  });

  it('rejects a per-learner question carrying only half its owner', async () => {
    await expect(
      t.db.execute(sql`
        insert into questions (id, user_id, enrollment_id, gloss_id, prompt_variant_id,
                               target_language, user_language_code, type, options)
        select 'q-half', 'u_1', null, gloss_id, prompt_variant_id, target_language,
               user_language_code, type, options
          from questions limit 1`),
    ).rejects.toThrow();
  });
});
