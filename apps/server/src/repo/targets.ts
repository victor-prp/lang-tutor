import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { sessionTargets, targetEvents, targets, targetWords } from '../db/schema';
import type { HoldingTarget } from '../domain/targetSkills';
import type { TargetKind } from '../domain/targets';
import { instantText } from './instants';

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

/** Phase 57 (spec D2, D9). What a target path's stock records of its target's day: the
 *  recorded yardstick (fsrsReadyCount) and what the stale check compares (capHalves,
 *  owedGlossIds, sorted). Values in half-points and percent, as the domain has them. */
export type SessionTargetRow = {
  targetId: string;
  daysLeft: number;
  capHalves: number;
  readinessPct: number;
  readyCount: number;
  wordCount: number;
  fsrsReadyCount: number;
  owedGlossIds: string[];
};

/** Phase 57 (spec D6). A target's word as its plan reads it: when it joined, and the
 *  learner day it was started (null until a session asks it). */
export type TargetWordRow = { glossId: string; addedAt: Date; startedOn: string | null };

/**
 * Phase 53 (spec D1, D8). Persistence primitives of a target, its words, its log and
 * what each of its path's stocks recorded (ADR 0001 R9). The rules — who may act, what counts as
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
     *  learner's changes to one target. Phase 57 (ADR 0014): FOR NO KEY UPDATE, which a
     *  change needs (none changes the id) and which leaves the key share a session end's
     *  writes take through their foreign keys (target_skill_events, session_targets, the
     *  session's own target_id) free, so a session end never waits on a target change that
     *  waits on it (a removal waits for the progress lock). */
    findTargetForUpdate: async (id: string): Promise<TargetRow | null> => {
      if (!UUID_RE.test(id)) return null;
      const [row] = await tx.select(targetColumns).from(targets).where(eq(targets.id, id)).for('no key update');
      return row ? asTarget(row) : null;
    },

    /** The enrollment's active targets on `today`: due on or after it (phase 57, spec D10:
     *  through the due date) and not ended early. Nearest due date first, then id. Each
     *  with its gloss ids, in the order they were added. */
    listActive: async (enrollmentId: string, today: string): Promise<(TargetRow & { glossIds: string[] })[]> => {
      const rows = await tx
        .select(targetColumns)
        .from(targets)
        .where(and(eq(targets.enrollmentId, enrollmentId), gte(targets.dueOn, today), isNull(targets.endedAt)))
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

    /**
     * Phase 57 (spec D4, D10). The enrollment's targets active on `day` holding any of
     * `glossIds`, as they stood at `asOf`, the instant of a session's last answer: not ended
     * by then, and due on or after `day` by the date they had then, which is the `before` of
     * the log's first date change after `asOf` (the date they have now when none came after).
     * Read so, the session-end write and the recompute see a target alike, whatever changed
     * since. Each with its words among `glossIds` and when they joined it (instantText), so an
     * answer given before can count for nothing. Nearest date first, then id.
     */
    listActiveHolding: async (enrollmentId: string, glossIds: readonly string[], day: string, asOf: string): Promise<HoldingTarget[]> => {
      if (glossIds.length === 0) return [];
      const rows = await tx.execute<{ id: string; due_on: string; gloss_id: string; added_at: string }>(sql`
        SELECT t.id, t.due_on::text AS due_on, w.gloss_id, ${instantText(sql`w.added_at`)} AS added_at
        FROM (
          SELECT t.id,
                 coalesce(
                   (SELECT (e.before->>'due_on')::date
                    FROM target_events e
                    WHERE e.target_id = t.id AND e.kind = 'date_changed' AND e.created_at > ${asOf}::timestamptz
                    ORDER BY e.created_at, e.id
                    LIMIT 1),
                   t.due_on) AS due_on
          FROM targets t
          WHERE t.enrollment_id = ${enrollmentId}
            AND (t.ended_at IS NULL OR t.ended_at > ${asOf}::timestamptz)
        ) t
        JOIN target_words w ON w.target_id = t.id
        WHERE t.due_on >= ${day}::date
          AND w.gloss_id IN (${sql.join(glossIds.map((glossId) => sql`${glossId}`), sql`, `)})
        ORDER BY t.due_on, t.id, w.added_at, w.gloss_id`);
      const held = new Map<string, HoldingTarget & { words: { glossId: string; addedAt: string }[] }>();
      for (const row of rows.rows) {
        let target = held.get(row.id);
        if (!target) {
          target = { id: row.id, dueOn: row.due_on, words: [] };
          held.set(row.id, target);
        }
        target.words.push({ glossId: row.gloss_id, addedAt: row.added_at });
      }
      return [...held.values()];
    },

    /** Phase 57 (spec D6). The day these words of a target started, for those not started yet:
     *  a word's first session sets it and no later one moves it. */
    markStarted: async (targetId: string, glossIds: readonly string[], day: string): Promise<void> => {
      if (glossIds.length === 0) return;
      await tx
        .update(targetWords)
        .set({ startedOn: day })
        .where(and(eq(targetWords.targetId, targetId), inArray(targetWords.glossId, [...glossIds]), isNull(targetWords.startedOn)));
    },

    /** Recompute only: no word started, before the replay starts them again. */
    clearStarted: async (): Promise<void> => {
      await tx.update(targetWords).set({ startedOn: null }).where(isNotNull(targetWords.startedOn));
    },

    /** Phase 57 (spec D6). A target's words with when each joined and the day it started, in
     *  the order they were added. */
    listWords: async (targetId: string): Promise<TargetWordRow[]> =>
      tx
        .select({ glossId: targetWords.glossId, addedAt: targetWords.addedAt, startedOn: targetWords.startedOn })
        .from(targetWords)
        .where(eq(targetWords.targetId, targetId))
        .orderBy(asc(targetWords.addedAt), asc(targetWords.glossId)),

    /** Phase 57 (ADR 0014). The ids of the enrollment's targets holding a gloss, active or
     *  not, sorted: those an unsave takes it out of. */
    listHolding: async (enrollmentId: string, glossId: string): Promise<string[]> => {
      const rows = await tx
        .select({ id: targets.id })
        .from(targets)
        .innerJoin(targetWords, eq(targetWords.targetId, targets.id))
        .where(and(eq(targets.enrollmentId, enrollmentId), eq(targetWords.glossId, glossId)))
        .orderBy(asc(targets.id));
      return rows.map((row) => row.id);
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

    /** Targets whose date has passed (due before `today`: phase 57, spec D10, a target is
     *  active through its date) that the learner did not end and the log does not yet record
     *  as ended on their date (spec D8): the first main-path stock chosen after the date
     *  writes that event. Nearest date first, then id. */
    listEndedUnrecorded: async (enrollmentId: string, today: string): Promise<TargetRow[]> => {
      const rows = await tx
        .select(targetColumns)
        .from(targets)
        .leftJoin(targetEvents, and(eq(targetEvents.targetId, targets.id), eq(targetEvents.kind, 'ended_on_date')))
        .where(and(eq(targets.enrollmentId, enrollmentId), lt(targets.dueOn, today), isNull(targets.endedAt), isNull(targetEvents.id)))
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

    /** Phase 57 (spec D2, D9). The one row a target path's stock records of its target's day. */
    insertSessionTarget: async (sessionId: string, row: SessionTargetRow): Promise<void> => {
      await tx.insert(sessionTargets).values({ sessionId, ...row });
    },

    /** Phase 57 (spec D2). What a target path's stock recorded of its target's day, for the
     *  stale check; undefined when it recorded nothing (a malformed id, a phase 53 split row
     *  with no cap). */
    findSessionTarget: async (
      sessionId: string,
      targetId: string,
    ): Promise<{ capHalves: number; owedGlossIds: string[] } | undefined> => {
      if (!UUID_RE.test(sessionId) || !UUID_RE.test(targetId)) return undefined;
      const [row] = await tx
        .select({ capHalves: sessionTargets.capHalves, owedGlossIds: sessionTargets.owedGlossIds })
        .from(sessionTargets)
        .where(and(eq(sessionTargets.sessionId, sessionId), eq(sessionTargets.targetId, targetId)));
      return row && row.capHalves !== null ? { capHalves: row.capHalves, owedGlossIds: row.owedGlossIds ?? [] } : undefined;
    },
  };
}

export type TargetRepo = ReturnType<typeof createTargetRepo>;
