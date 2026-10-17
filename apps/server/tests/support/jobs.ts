import { sql } from 'drizzle-orm';
import { PgBoss, fromDrizzle } from 'pg-boss';

import type { Db } from '../../src/db/client';
import { JOB_SCHEMA } from '../../src/db/jobs';
import { STOCK_SESSION, type StockSessionPayload } from '../../src/domain/jobs';

// The test composition root's pg-boss (ADR 0004 R6): on the test's own cloned
// database, through the same adapter installJobs uses, so no second pool.
// migrate is off because the template already installed the schema. supervise
// is off, so nothing expires behind a test's back, and so are cron and the
// instance registry.
function testBoss(db: Db): PgBoss {
  return new PgBoss({
    db: fromDrizzle(db, sql),
    schema: JOB_SCHEMA,
    migrate: false,
    supervise: false,
    schedule: false,
    registerInstance: false,
  });
}

/** For tests that enqueue or work jobs. Pair with stopTestBoss in afterEach. */
export async function startTestBoss(db: Db): Promise<PgBoss> {
  const boss = testBoss(db);
  boss.on('error', (error) => {
    // A test that provokes no pg-boss failure should see none. Printed rather
    // than thrown: an emitter throw would surface in whatever test runs next.
    console.error('pg-boss error in test', error);
  });
  await boss.start();
  return boss;
}

/** For tests that must not enqueue: send() throws "Queue cache is not
 *  initialized", which is the loud failure such a test wants. Phase 43: a
 *  request for the next session in stock is the one exception, dropped. Every
 *  first answer, ending and skip makes one, so a test about anything else would
 *  otherwise need a running queue; a test about the stock starts a real boss
 *  (jobs/stockSession.test.ts). The app only ever calls send() and upsert()
 *  on it. */
export function unstartedBoss(db: Db): PgBoss {
  const boss = testBoss(db);
  const send = boss.send.bind(boss) as (...args: unknown[]) => Promise<string | null>;
  const upsert = boss.upsert.bind(boss) as (...args: unknown[]) => Promise<unknown>;
  return {
    send: (name: string, ...rest: unknown[]) => (name === STOCK_SESSION ? Promise.resolve(null) : send(name, ...rest)),
    upsert: (name: string, ...rest: unknown[]) =>
      name === STOCK_SESSION ? Promise.resolve({ jobs: [], updated: 0, inserted: 0 }) : upsert(name, ...rest),
  } as unknown as PgBoss;
}

export async function stopTestBoss(boss: PgBoss): Promise<void> {
  await boss.stop({ graceful: true, timeout: 5_000 });
}

export async function countJobs(db: Db, name: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from ${sql.raw(JOB_SCHEMA)}.job where name = ${name}`,
  );
  return rows.rows[0].n;
}

/** Phase 31. The payloads of every job of one queue, oldest first. */
export async function jobPayloads(db: Db, name: string): Promise<unknown[]> {
  const rows = await db.execute<{ data: unknown }>(
    sql`select data from ${sql.raw(JOB_SCHEMA)}.job where name = ${name} order by created_on`,
  );
  return rows.rows.map((row) => row.data);
}

/** Polls until `check` holds, for effects a worker produces on its own schedule. */
export async function waitFor(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Phase 57 (spec D2). The stock jobs queued, oldest first: each one's singleton key (its path's)
 *  and payload. A service test may not name the job schema itself. */
export async function stockJobKeys(db: Db): Promise<{ key: string | null; data: StockSessionPayload }[]> {
  const rows = await db.execute<{ key: string | null; data: StockSessionPayload }>(
    sql`select singleton_key as key, data from ${sql.raw(JOB_SCHEMA)}.job where name = ${STOCK_SESSION} order by created_on, singleton_key`,
  );
  return rows.rows;
}
