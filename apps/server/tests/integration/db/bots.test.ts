import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createBots } from '../../../src/db/bots';
import { createAuthRepo } from '../../../src/repo/auth';
import { seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';

// Phase 35 (spec D11). `npm run db:bots:create -- --day <day> <names…>`: the one
// way a bot profile comes to exist.
let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

async function botRows() {
  const result = await t.db.execute(sql`
    select a.email, a.name, a.email_verified, u.username, u.display_name, u.kind, u.bot_day::text as bot_day
    from users u join auth_users a on a.id = u.id
    where u.kind = 'bot' order by u.username`);
  return result.rows;
}

async function counts() {
  const result = await t.db.execute(sql`
    select (select count(*) from users)::int as users, (select count(*) from auth_users)::int as identities,
           (select count(*) from auth_accounts)::int as accounts, (select count(*) from auth_sessions)::int as sessions`);
  return result.rows[0];
}

describe('createBots', () => {
  it('creates each bot as an unclaimed .invalid identity and a bot profile on the given day', async () => {
    const outcome = await createBots(t.db, { names: ['steady-en', 'fast-ru'], day: '2026-10-11' });
    expect(outcome).toEqual({ created: ['steady-en', 'fast-ru'], existing: [] });
    expect(await botRows()).toEqual([
      { email: 'fast-ru@bots.invalid', name: 'fast-ru', email_verified: false, username: 'fast_ru', display_name: 'fast-ru', kind: 'bot', bot_day: '2026-10-11' },
      { email: 'steady-en@bots.invalid', name: 'steady-en', email_verified: false, username: 'steady_en', display_name: 'steady-en', kind: 'bot', bot_day: '2026-10-11' },
    ]);
  });

  it('is idempotent: a second run creates nothing and moves no day', async () => {
    await createBots(t.db, { names: ['steady-en'], day: '2026-10-11' });
    const before = await counts();
    const outcome = await createBots(t.db, { names: ['steady-en', 'steady-en'], day: '2026-12-01' });
    expect(outcome).toEqual({ created: [], existing: ['steady-en'] });
    expect(await counts()).toEqual(before);
    expect((await botRows()).map((r) => r.bot_day)).toEqual(['2026-10-11']);
  });

  it('adds only the missing ones when some exist', async () => {
    await createBots(t.db, { names: ['steady-en'], day: '2026-10-11' });
    expect(await createBots(t.db, { names: ['steady-en', 'fast-ru'], day: '2026-10-11' })).toEqual({
      created: ['fast-ru'],
      existing: ['steady-en'],
    });
  });

  it("refuses a name whose username a learner holds, and creates none of the batch", async () => {
    await seedUser(t.db, 'dana_en');
    const before = await counts();
    await expect(createBots(t.db, { names: ['fast-ru', 'dana-en'], day: '2026-10-11' })).rejects.toThrow(/dana-en/);
    expect(await counts()).toEqual(before);
  });

  it('refuses a malformed name or day before writing anything', async () => {
    for (const names of [['Steady'], ['steady_en'], ['ab'], ['a'.repeat(31)], []]) {
      await expect(createBots(t.db, { names, day: '2026-10-11' })).rejects.toThrow();
    }
    await expect(createBots(t.db, { names: ['steady-en'], day: '2026-02-30' })).rejects.toThrow();
    expect(await botRows()).toEqual([]);
  });
});

describe('a bot and the claim command', () => {
  it('is never claimed: its identity stays .invalid', async () => {
    await createBots(t.db, { names: ['steady-en'], day: '2026-10-11' });
    expect(await createAuthRepo(t.db).claimAccount({ username: 'steady_en', email: 'someone@example.com' })).toBe(
      'no_such_user',
    );
    expect((await botRows()).map((r) => r.email)).toEqual(['steady-en@bots.invalid']);
  });
});
