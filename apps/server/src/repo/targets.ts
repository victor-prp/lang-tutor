import { and, asc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { sessionTargets, targetEvents, targets, targetWords } from '../db/schema';
import type { TargetSplit } from '../domain/targetSession';
import type { ShareReason, TargetKind } from '../domain/targets';

// `targets.id` is a `uuid` column: a malformed value makes Postgres raise 22P02
// before a WHERE clause can run, which would surface as a 500 where a target id
// from a URL that matches nothing means "not found". Reject the shape first, as
// repo/sessions.ts does for a session id.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TargetRow = {
  id: string;
  enrollmentId: string;
  kind: TargetKind;
  /** A learner day, 'YYYY-MM-DD' (ADR 0013). */
  dueOn: string;
  createdAt: Date;
  endedAt: Date | null;
};

/** One line of the append-only log (spec D8). `before` and `after` are the
 *  service's own shapes, per kind; null stores SQL NULL. */
export type TargetEventInput = {
  targetId: string;
  kind: 'created' | 'words_added' | 'words_removed' | 'date_changed' | 'ended_early' | 'ended_on_date';
  before: unknown | null;
  after: unknown | null;
  actorUserId: string | null;
  sessionId: string | null;
};

const targetColumns = {
  id: targets.id,
  enrollmentId: targets.enrollmentId,
  kind: targets.kind,
  dueOn: targets.dueOn,
  createdAt: targets.createdAt,
  endedAt: targets.endedAt,
};

const asTarget = (row: Omit<TargetRow, 'kind'> & { kind: string }): TargetRow => ({ ...row, kind: row.kind as TargetKind });

/**
 * Phase 53 (spec D1, D8). Persistence primitives of a target, its words, its log and
 * the split each session recorded (ADR 0001 R9). The rules — who may act, what counts as
 * active for a change, the stock a change retires — are the service's; every method here
 * does one thing and reports what it did.
 */
export function createTargetRepo(tx: Tx) {
  return {
    insertTarget: async (row: { enrollmentId: string; kind: TargetKind; dueOn: string }): Promise<TargetRow> => {
      const [inserted] = await tx.insert(targets).values(row).returning(targetColumns);
      return asTarget(inserted);
    },

    /** Any of an enrollment's targets, active or not; null for a malformed id. */
    findTarget: async (id: string): Promise<TargetRow | null> => {
      if (!UUID_RE.test(id)) return null;
      const [row] = await tx.select(targetColumns).from(targets).where(eq(targets.id, id));
      return row ? asTarget(row) : null;
    },

    /** findTarget that locks the row until the transaction ends: it serializes the
     *  learner's changes to one target. */
    findTargetForUpdate: async (id: string): Promise<TargetRow | null> => {
      if (!UUID_RE.test(id)) return null;
      const [row] = await tx.select(targetColumns).from(targets).where(eq(targets.id, id)).for('update');
      return row ? asTarget(row) : null;
    },

    /** The enrollment's active targets on `today`: due after it and not ended early.
     *  Nearest due date first, then id, which is the order the picker serves them in.
     *  Each with its gloss ids, in the order they were added. */
    listActive: async (enrollmentId: string, today: string): Promise<(TargetRow & { glossIds: string[] })[]> => {
      const rows = await tx
        .select(targetColumns)
        .from(targets)
        .where(and(eq(targets.enrollmentId, enrollmentId), gt(targets.dueOn, today), isNull(targets.endedAt)))
        .orderBy(asc(targets.dueOn), asc(targets.id));
      if (rows.length === 0) return [];
      const words = await tx
        .select({ targetId: targetWords.targetId, glossId: targetWords.glossId })
        .from(targetWords)
        .where(
          inArray(
            targetWords.targetId,
            rows.map((row) => row.id),
          ),
        )
        .orderBy(asc(targetWords.addedAt), asc(targetWords.glossId));
      const glossIdsOf = new Map<string, string[]>();
      for (const { targetId, glossId } of words) {
        const list = glossIdsOf.get(targetId);
        if (list) list.push(glossId);
        else glossIdsOf.set(targetId, [glossId]);
      }
      return rows.map((row) => ({ ...asTarget(row), glossIds: glossIdsOf.get(row.id) ?? [] }));
    },

    /** A target's gloss ids, in the order they were added. */
    listWordIds: async (targetId: string): Promise<string[]> => {
      const rows = await tx
        .select({ glossId: targetWords.glossId })
        .from(targetWords)
        .where(eq(targetWords.targetId, targetId))
        .orderBy(asc(targetWords.addedAt), asc(targetWords.glossId));
      return rows.map((row) => row.glossId);
    },

    /** Adds the glosses a target does not hold yet and answers which those were, in the
     *  order given. A word already there stays as it is: it keeps its place and its
     *  `added_at`. `added_at` is now() for the whole transaction, so each word gets a
     *  microsecond more than the one before it: the order a target lists its words in
     *  is the order they were given in, which a batch added together would otherwise lose. */
    addWords: async (targetId: string, glossIds: readonly string[]): Promise<string[]> => {
      const wanted = [...new Set(glossIds)];
      if (wanted.length === 0) return [];
      const rows = await tx
        .insert(targetWords)
        .values(
          wanted.map((glossId, position) => ({
            targetId,
            glossId,
            addedAt: sql`now() + ${position} * interval '1 microsecond'`,
          })),
        )
        .onConflictDoNothing()
        .returning({ glossId: targetWords.glossId });
      const added = new Set(rows.map((row) => row.glossId));
      return wanted.filter((glossId) => added.has(glossId));
    },

    /** True when the target held the gloss. */
    removeWord: async (targetId: string, glossId: string): Promise<boolean> => {
      const rows = await tx
        .delete(targetWords)
        .where(and(eq(targetWords.targetId, targetId), eq(targetWords.glossId, glossId)))
        .returning({ glossId: targetWords.glossId });
      return rows.length > 0;
    },

    /** Unsaving a word (spec D1): it leaves every target of the enrollment, an ended one
     *  too, since a target's screen shows its words from the saved list. Answers the ids
     *  of the targets it left, sorted. */
    removeGlossFromTargets: async (enrollmentId: string, glossId: string): Promise<string[]> => {
      const rows = await tx
        .delete(targetWords)
        .where(
          and(
            eq(targetWords.glossId, glossId),
            inArray(targetWords.targetId, tx.select({ id: targets.id }).from(targets).where(eq(targets.enrollmentId, enrollmentId))),
          ),
        )
        .returning({ targetId: targetWords.targetId });
      return rows.map((row) => row.targetId).sort();
    },

    setDueOn: async (id: string, dueOn: string): Promise<void> => {
      await tx.update(targets).set({ dueOn }).where(eq(targets.id, id));
    },

    /** Ends a target early. True when this call ended it: only a target not ended yet. */
    end: async (id: string, at: Date): Promise<boolean> => {
      const rows = await tx
        .update(targets)
        .set({ endedAt: at })
        .where(and(eq(targets.id, id), isNull(targets.endedAt)))
        .returning({ id: targets.id });
      return rows.length > 0;
    },

    /** Targets whose date has come (due on or before `today`) that the learner did not end
     *  and the log does not yet record as ended on their date (spec D8): the first session
     *  chosen after the date writes that event. Nearest date first, then id. */
    listEndedUnrecorded: async (enrollmentId: string, today: string): Promise<TargetRow[]> => {
      const rows = await tx
        .select(targetColumns)
        .from(targets)
        .leftJoin(targetEvents, and(eq(targetEvents.targetId, targets.id), eq(targetEvents.kind, 'ended_on_date')))
        .where(and(eq(targets.enrollmentId, enrollmentId), lte(targets.dueOn, today), isNull(targets.endedAt), isNull(targetEvents.id)))
        .orderBy(asc(targets.dueOn), asc(targets.id));
      return rows.map(asTarget);
    },

    insertEvent: async (event: TargetEventInput): Promise<void> => {
      await tx.insert(targetEvents).values({
        targetId: event.targetId,
        kind: event.kind,
        before: event.before,
        after: event.after,
        actorUserId: event.actorUserId,
        sessionId: event.sessionId,
      });
    },

    /** The split a session was chosen with (spec D8), one row per target it served. */
    insertSessionSplit: async (sessionId: string, rows: readonly TargetSplit[]): Promise<void> => {
      if (rows.length === 0) return;
      await tx.insert(sessionTargets).values(
        rows.map((row) => ({
          sessionId,
          targetId: row.targetId,
          wish: row.wish,
          slots: row.slots,
          picked: row.picked,
          reason: row.reason,
          daysLeft: row.daysLeft,
          readyCount: row.readyCount,
          wordCount: row.wordCount,
        })),
      );
    },

    /** What insertSessionSplit recorded, by target id; empty for a session that served no
     *  target, and for a malformed id. */
    findSessionSplit: async (sessionId: string): Promise<TargetSplit[]> => {
      if (!UUID_RE.test(sessionId)) return [];
      const rows = await tx
        .select({
          targetId: sessionTargets.targetId,
          wish: sessionTargets.wish,
          slots: sessionTargets.slots,
          picked: sessionTargets.picked,
          reason: sessionTargets.reason,
          daysLeft: sessionTargets.daysLeft,
          readyCount: sessionTargets.readyCount,
          wordCount: sessionTargets.wordCount,
        })
        .from(sessionTargets)
        .where(eq(sessionTargets.sessionId, sessionId))
        .orderBy(asc(sessionTargets.targetId));
      return rows.map((row) => ({ ...row, reason: row.reason as ShareReason }));
    },
  };
}

export type TargetRepo = ReturnType<typeof createTargetRepo>;
