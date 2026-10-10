import type { PhotoImportItemReason, PhotoImportOption } from '@lang-tutor/core/api';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { photoImportItems, photoImports } from '../db/schema';
import type { StoredImportStatus, StoredItemStatus } from '../domain/photoImports';

// An id that is not a uuid is "no such import", not a Postgres type error.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An import without its photo: that is up to 2.8 MB, and only the read-photo
 *  job needs it (findPhoto). */
export type PhotoImportRow = {
  id: string;
  enrollmentId: string;
  status: StoredImportStatus;
  createdAt: Date;
};

export type PhotoImportListRow = {
  id: string;
  enrollmentId: string;
  status: StoredImportStatus;
  createdAt: Date;
  itemCount: number;
  settledCount: number;
  pendingCount: number;
};

export type PhotoImportItemRow = {
  importId: string;
  position: number;
  text: string;
  hebrew: string | null;
  status: StoredItemStatus;
  correctedForm: string | null;
  options: PhotoImportOption[];
  suggestedGlossId: string | null;
  chosenGlossId: string | null;
  ticked: boolean;
  hebrewMismatch: boolean;
  reason: PhotoImportItemReason | null;
};

/** What a row's lookup decided (spec D7). */
export type ItemResult = {
  correctedForm: string | null;
  options: PhotoImportOption[];
  chosenGlossId: string | null;
  ticked: boolean;
  hebrewMismatch: boolean;
  reason: PhotoImportItemReason | null;
};

// Every column but the photo.
const importColumns = {
  id: photoImports.id,
  enrollmentId: photoImports.enrollmentId,
  status: photoImports.status,
  createdAt: photoImports.createdAt,
};

const itemColumns = {
  importId: photoImportItems.importId,
  position: photoImportItems.position,
  text: photoImportItems.text,
  hebrew: photoImportItems.hebrew,
  status: photoImportItems.status,
  correctedForm: photoImportItems.correctedForm,
  options: photoImportItems.options,
  suggestedGlossId: photoImportItems.suggestedGlossId,
  chosenGlossId: photoImportItems.chosenGlossId,
  ticked: photoImportItems.ticked,
  hebrewMismatch: photoImportItems.hebrewMismatch,
  reason: photoImportItems.reason,
};

const asItem = (row: typeof photoImportItems.$inferSelect | Record<keyof typeof itemColumns, unknown>) =>
  row as unknown as PhotoImportItemRow;

const itemKey = (importId: string, position: number) =>
  and(eq(photoImportItems.importId, importId), eq(photoImportItems.position, position));

/** Phase 26. Persistence primitives of an import and its rows (ADR 0001 R9). */
export function createPhotoImportRepo(tx: Tx) {
  return {
    insertImport: async (input: { enrollmentId: string; photo: string }): Promise<{ id: string; createdAt: Date }> => {
      const [row] = await tx
        .insert(photoImports)
        .values({ enrollmentId: input.enrollmentId, status: 'reading', photo: input.photo })
        .returning({ id: photoImports.id, createdAt: photoImports.createdAt });
      return row;
    },

    /** Spec D10's cleanup. The rows go with their import (ON DELETE CASCADE). */
    deleteExpired: async (input: { enrollmentId: string; before: Date }): Promise<number> => {
      const rows = await tx
        .delete(photoImports)
        .where(and(eq(photoImports.enrollmentId, input.enrollmentId), lt(photoImports.createdAt, input.before)))
        .returning({ id: photoImports.id });
      return rows.length;
    },

    findImport: async (id: string): Promise<PhotoImportRow | null> => {
      if (!UUID_RE.test(id)) return null;
      const [row] = await tx.select(importColumns).from(photoImports).where(eq(photoImports.id, id));
      return row ? { ...row, status: row.status as StoredImportStatus } : null;
    },

    /** findImport that locks the row until the transaction ends. It serializes the
     *  learner's changes, save and discard on one import. */
    findImportForUpdate: async (id: string): Promise<PhotoImportRow | null> => {
      if (!UUID_RE.test(id)) return null;
      const [row] = await tx.select(importColumns).from(photoImports).where(eq(photoImports.id, id)).for('update');
      return row ? { ...row, status: row.status as StoredImportStatus } : null;
    },

    /** The photo, while the import is reading; null once it is cleared, or for
     *  no such import. The read-photo job's read, and no one else's. */
    findPhoto: async (id: string): Promise<string | null> => {
      if (!UUID_RE.test(id)) return null;
      const [row] = await tx.select({ photo: photoImports.photo }).from(photoImports).where(eq(photoImports.id, id));
      return row?.photo ?? null;
    },

    /** Open imports (not saved or discarded, made since `since`) with their row
     *  counts, newest first. One enrollment's, served by the enrollment index. */
    listOpen: async (input: { enrollmentId: string; since: Date }): Promise<PhotoImportListRow[]> => {
      const rows = await tx.execute<{
        id: string;
        enrollment_id: string;
        status: string;
        created_at: Date | string;
        item_count: number;
        settled_count: number;
      }>(sql`
        SELECT i.id, i.enrollment_id, i.status, i.created_at,
               count(it.position)::int AS item_count,
               (count(it.position) FILTER (WHERE it.status <> 'pending'))::int AS settled_count
        FROM photo_imports i
        LEFT JOIN photo_import_items it ON it.import_id = i.id
        WHERE i.enrollment_id = ${input.enrollmentId}
          AND i.status NOT IN ('saved', 'discarded')
          AND i.created_at >= ${input.since.toISOString()}::timestamptz
        GROUP BY i.id
        ORDER BY i.created_at DESC`);
      return rows.rows.map((row) => ({
        id: row.id,
        enrollmentId: row.enrollment_id,
        status: row.status as StoredImportStatus,
        createdAt: new Date(row.created_at),
        itemCount: row.item_count,
        settledCount: row.settled_count,
        pendingCount: row.item_count - row.settled_count,
      }));
    },

    /** Conditional, like a session's: false when the import was not in `from`.
     *  Always clears the photo, since no transition leads back to `reading`. */
    transition: async (id: string, from: StoredImportStatus[], to: StoredImportStatus): Promise<boolean> => {
      if (!UUID_RE.test(id)) return false;
      const rows = await tx
        .update(photoImports)
        .set({ status: to, photo: null })
        .where(and(eq(photoImports.id, id), inArray(photoImports.status, from)))
        .returning({ id: photoImports.id });
      return rows.length > 0;
    },

    insertItems: async (
      importId: string,
      items: { position: number; text: string; hebrew: string | null }[],
    ): Promise<void> => {
      if (items.length === 0) return;
      await tx
        .insert(photoImportItems)
        .values(items.map((item) => ({ importId, position: item.position, text: item.text, hebrew: item.hebrew, status: 'pending' })));
    },

    listItems: async (importId: string): Promise<PhotoImportItemRow[]> => {
      if (!UUID_RE.test(importId)) return [];
      const rows = await tx
        .select(itemColumns)
        .from(photoImportItems)
        .where(eq(photoImportItems.importId, importId))
        .orderBy(asc(photoImportItems.position));
      return rows.map(asItem);
    },

    findItem: async (importId: string, position: number): Promise<PhotoImportItemRow | null> => {
      if (!UUID_RE.test(importId)) return null;
      const [row] = await tx.select(itemColumns).from(photoImportItems).where(itemKey(importId, position));
      return row ? asItem(row) : null;
    },

    /** The job's write, once: only a pending row takes it. */
    writeItem: async (importId: string, position: number, result: ItemResult): Promise<boolean> => {
      const rows = await tx
        .update(photoImportItems)
        .set({
          status: 'ready',
          correctedForm: result.correctedForm,
          options: result.options,
          suggestedGlossId: result.chosenGlossId,
          chosenGlossId: result.chosenGlossId,
          ticked: result.ticked,
          hebrewMismatch: result.hebrewMismatch,
          reason: result.reason,
        })
        .where(and(itemKey(importId, position), eq(photoImportItems.status, 'pending')))
        .returning({ position: photoImportItems.position });
      return rows.length > 0;
    },

    markItemFailed: async (importId: string, position: number): Promise<boolean> => {
      if (!UUID_RE.test(importId)) return false;
      const rows = await tx
        .update(photoImportItems)
        .set({ status: 'failed', ticked: false })
        .where(and(itemKey(importId, position), eq(photoImportItems.status, 'pending')))
        .returning({ position: photoImportItems.position });
      return rows.length > 0;
    },

    /** The learner's change. The service has already checked it (domain
     *  refuseItemUpdate). */
    updateItem: async (
      importId: string,
      position: number,
      update: { ticked?: boolean; chosenGlossId?: string },
    ): Promise<PhotoImportItemRow | null> => {
      if (!UUID_RE.test(importId)) return null;
      const [row] = await tx
        .update(photoImportItems)
        .set({
          ...(update.ticked !== undefined ? { ticked: update.ticked } : {}),
          ...(update.chosenGlossId !== undefined ? { chosenGlossId: update.chosenGlossId } : {}),
        })
        .where(itemKey(importId, position))
        .returning(itemColumns);
      return row ? asItem(row) : null;
    },
  };
}

export type PhotoImportRepo = ReturnType<typeof createPhotoImportRepo>;
