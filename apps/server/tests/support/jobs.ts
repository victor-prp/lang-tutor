import { sql } from 'drizzle-orm';
import { PgBoss, fromDrizzle } from 'pg-boss';

import type { Db } from '../../src/db/client';
import { JOB_SCHEMA } from '../../src/db/jobs';

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
 *  initialized", which is the loud failure such a test wants. */
export function unstartedBoss(db: Db): PgBoss {
  return testBoss(db);
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
