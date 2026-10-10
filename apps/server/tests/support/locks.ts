import { sql } from 'drizzle-orm';

import type { Db, Tx } from '../../src/db/client';
import { createDictRepo } from '../../src/repo/dictionary';
import { createGlossRepo } from '../../src/repo/glosses';

/**
 * Phase 31. Runs `work` in a transaction that stays open until `release()`, so a
 * test can line another transaction up behind its locks. `ready` resolves once
 * `work` has run, whether it threw or not; `done` settles with the transaction.
 */
export function holdOpen(db: Db, work: (tx: Tx) => Promise<void>): { ready: Promise<void>; release: () => void; done: Promise<void> } {
  let release!: () => void;
  let markReady!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const done = db.transaction(async (tx) => {
    try {
      await work(tx);
    } finally {
      markReady();
    }
    await gate;
  });
  return { ready, release, done };
}

/** A merge held open under its lexeme's lock: what the merge job does, paused. */
export function holdMergeOpen(db: Db, input: { lexemeId: string; survivorId: string; otherId: string }) {
  return holdOpen(db, async (tx) => {
    await createDictRepo(tx).lockLexemes([input.lexemeId]);
    await createGlossRepo(tx).mergeGlosses({ survivorId: input.survivorId, otherId: input.otherId });
  });
}

/** Polls until some session of this database waits on a lock. */
export async function waitForBlockedQuery(db: Db, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`);
    if (rows.rows[0].n > 0) return;
    if (Date.now() > deadline) throw new Error(`no query blocked on a lock within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
