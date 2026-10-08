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

  it('refuses an email held by an identity that has a profile, and changes nothing', async () => {
    await seedUser(t.db, 'u_one');
    await seedUser(t.db, 'u_two');
    const repo = createAuthRepo(t.db);
    await repo.claimAccount({ username: 'u_one', email: 'taken@example.com' });
    expect(await repo.claimAccount({ username: 'u_two', email: 'TAKEN@example.com' })).toBe('email_taken');
    const rows = await t.db.execute(sql`select id, email from auth_users order by id`);
    expect(rows.rows).toEqual([
      { id: 'u_one', email: 'taken@example.com' },
      { id: 'u_two', email: 'u_two@test.invalid' },
    ]);
  });

  it('claims only an unclaimed account', async () => {
    await seedUser(t.db, 'vic1');
    const repo = createAuthRepo(t.db);
    expect(await repo.claimAccount({ username: 'vic1', email: 'first@example.com' })).toBe('claimed');
    expect(await repo.claimAccount({ username: 'vic1', email: 'second@example.com' })).toBe('already_claimed');
    const rows = await t.db.execute(sql`select email from auth_users where id = 'vic1'`);
    expect(rows.rows).toEqual([{ email: 'first@example.com' }]);
  });

  it('takes the address over from an identity that never made a profile, its sessions with it', async () => {
    await seedUser(t.db, 'vic1');
    // Signed in on the new build before the claim, and never onboarded.
    await t.db.execute(
      sql`insert into auth_users (id, name, email, email_verified) values ('stray', '', 'victor@example.com', true)`,
    );
    await t.db.execute(
      sql`insert into auth_sessions (token, user_id, expires_at) values ('stray-token', 'stray', now() + interval '1 day')`,
    );
    const repo = createAuthRepo(t.db);
    expect(await repo.claimAccount({ username: 'vic1', email: 'Victor@Example.com' })).toBe('claimed');

    const identities = await t.db.execute(sql`select id, email, email_verified from auth_users order by id`);
    expect(identities.rows).toEqual([{ id: 'vic1', email: 'victor@example.com', email_verified: false }]);
    const sessions = await t.db.execute(sql`select count(*)::int as n from auth_sessions`);
    expect(sessions.rows[0]).toEqual({ n: 0 });
  });
});
