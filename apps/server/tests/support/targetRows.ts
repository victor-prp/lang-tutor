import { asc, eq } from 'drizzle-orm';

import type { Db } from '../../src/db/client';
import { sessions, targetEvents } from '../../src/db/schema';
import type { TargetSplit } from '../../src/domain/targetSession';
import type { TargetKind } from '../../src/domain/targets';
import { createTargetRepo } from '../../src/repo/targets';
import { withTx } from './withTx';

/**
 * Phase 53. Targets for a test, and reads of what sessions recorded for them. tests/support/
 * is the test composition root, so a service test reaches these tables only through here.
 */

/** A target of `enrollmentId` holding `glossIds`, written through the repository with none of
 *  the targets service's rules: a test about sessions sets one up directly. Answers its id. */
export function seedTarget(
  db: Db,
  input: { enrollmentId: string; kind: TargetKind; dueOn: string; glossIds: string[] },
): Promise<string> {
  return withTx(db, async (tx) => {
    const targets = createTargetRepo(tx);
    const { id } = await targets.insertTarget({ enrollmentId: input.enrollmentId, kind: input.kind, dueOn: input.dueOn });
    await targets.addWords(id, input.glossIds);
    return id;
  });
}

/** The split a session was chosen with (spec D8), one row per target it served. */
export function readSessionSplit(db: Db, sessionId: string): Promise<TargetSplit[]> {
  return withTx(db, (tx) => createTargetRepo(tx).findSessionSplit(sessionId));
}

/** A target's log (spec D8), oldest first. */
export function readTargetEvents(db: Db, targetId: string) {
  return db
    .select({
      kind: targetEvents.kind,
      before: targetEvents.before,
      after: targetEvents.after,
      actorUserId: targetEvents.actorUserId,
      sessionId: targetEvents.sessionId,
    })
    .from(targetEvents)
    .where(eq(targetEvents.targetId, targetId))
    .orderBy(asc(targetEvents.createdAt), asc(targetEvents.id));
}

/** Spec D12. What became of a stock: its status, the day it counted for (none for one
 *  retired) and the learner day its words were chosen on. */
export async function readStockRow(db: Db, sessionId: string) {
  const [row] = await db
    .select({ status: sessions.status, practiceDay: sessions.practiceDay, chosenOn: sessions.chosenOn })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  return row;
}
