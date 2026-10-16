import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import type { Db, Tx } from '../../src/db/client';
import { createDictRepo } from '../../src/repo/dictionary';
import { createGlossRepo } from '../../src/repo/glosses';
import { createJobRepo } from '../../src/repo/jobs';
import { createProgressRepo } from '../../src/repo/progress';
import { STOCK_SESSION } from '../../src/domain/jobs';

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

/**
 * Phase 34. The stale-form repair of one variant's single rendering, held open
 * under its lexeme's lock: what a lookup's repair does, paused. `translation`
 * unchanged is a repair that keeps the words; changed, one that rewords them.
 */
export function holdRepairOpen(
  db: Db,
  input: { lexemeId: string; variantId: string; senseId: string; translation: string },
) {
  return holdOpen(db, async (tx) => {
    const dict = createDictRepo(tx);
    await dict.lockLexemes([input.lexemeId]);
    await dict.repairVariantRenderings({
      variantId: input.variantId,
      lexemeId: input.lexemeId,
      userLanguageCode: 'he',
      senseVersion: await dict.findSenseVersion({ lexemeId: input.lexemeId }),
      lemmaForm: true,
      senses: [
        {
          senseId: input.senseId, rank: 0, translation: input.translation, gloss: input.translation,
          alternatives: [], glossAlternatives: [], definition: null, exampleSource: null, exampleTarget: null,
        },
      ],
    });
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

/** Phase 57 (rulings T4-i, T4-k). An enrollment's progress lock held open: a session end, paused
 *  before it reads its evidence. */
export function holdProgressLock(db: Db, enrollmentId: string) {
  return holdOpen(db, async (tx) => {
    await createProgressRepo(tx).lockEnrollment(enrollmentId);
  });
}

/** Phase 57 (ADR 0014 R4). A session end paused after its progress lock: `finish()` lets it ask
 *  for its path's next stock (the main path's, under the enrollment's key), as an ending does,
 *  and commit. `ready` resolves once the lock is held; `done` settles with the transaction. */
export function holdSessionEnd(db: Db, boss: PgBoss, enrollmentId: string): { ready: Promise<void>; finish: () => void; done: Promise<void> } {
  let finish!: () => void;
  let markReady!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const done = db.transaction(async (tx) => {
    try {
      await createProgressRepo(tx).lockEnrollment(enrollmentId);
    } finally {
      markReady();
    }
    await gate;
    await createJobRepo(tx, boss).enqueue(STOCK_SESSION, { enrollment_id: enrollmentId, reason: 'complete' }, { singletonKey: enrollmentId });
  });
  return { ready, finish, done };
}
