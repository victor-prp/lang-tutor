import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createAuthRepo } from '../../../src/repo/auth';
import { seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

describe('the send log', () => {
  it('counts only this address, only since the given time', async () => {
    const repo = createAuthRepo(t.db);
    await repo.recordSend('a@example.com');
    await repo.recordSend('a@example.com');
    await repo.recordSend('b@example.com');
    expect(await repo.countSendsSince('a@example.com', new Date(Date.now() - 60_000))).toBe(2);
    expect(await repo.countSendsSince('a@example.com', new Date(Date.now() + 60_000))).toBe(0);
  });

  it('prunes rows older than the cut-off and keeps the rest', async () => {
    const repo = createAuthRepo(t.db);
    await t.db.execute(sql`insert into auth_code_sends (email, sent_at) values ('old@example.com', now() - interval '2 days')`);
    await repo.recordSend('new@example.com');
    await repo.pruneSendsBefore(new Date(Date.now() - 24 * 3600_000));
    const rows = await t.db.execute(sql`select email from auth_code_sends`);
    expect(rows.rows).toEqual([{ email: 'new@example.com' }]);
  });
});

describe('claimAccount', () => {
  it('sets the lower-cased email on the identity behind a username', async () => {
    await seedUser(t.db, 'vic1_id');
    const repo = createAuthRepo(t.db);
    expect(await repo.claimAccount({ username: 'vic1_id', email: ' Victor@Example.com ' })).toBe('claimed');
    const rows = await t.db.execute(sql`select email from auth_users where id = 'vic1_id'`);
    expect(rows.rows).toEqual([{ email: 'victor@example.com' }]);
  });

  it('reports an unknown username and changes nothing', async () => {
    const repo = createAuthRepo(t.db);
    expect(await repo.claimAccount({ username: 'nobody', email: 'x@example.com' })).toBe('no_such_user');
  });

  it('refuses an email another identity already holds', async () => {
    await seedUser(t.db, 'u_one');
    await seedUser(t.db, 'u_two');
    const repo = createAuthRepo(t.db);
    await repo.claimAccount({ username: 'u_one', email: 'taken@example.com' });
    expect(await repo.claimAccount({ username: 'u_two', email: 'TAKEN@example.com' })).toBe('email_taken');
    const rows = await t.db.execute(sql`select email from auth_users where id = 'u_two'`);
    expect(rows.rows).toEqual([{ email: 'u_two@test.invalid' }]);
  });
});
