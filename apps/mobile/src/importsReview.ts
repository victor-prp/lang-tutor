import type { PhotoImport, PhotoImportItem } from '@lang-tutor/core/api';
import { firstRowPerGloss } from '@lang-tutor/core/domain';

import { shouldPollImport } from '@/photoImports';
import { strings } from '@/strings';

/**
 * Phase 53 (spec D10, ruling R-D9). The target wizard's review. Each photo is its own
 * photo import, and the rows of all of them are reviewed as one list: in import order,
 * then by position, a gloss once (firstRowPerGloss, which the server's save of a target
 * applies too, so what is shown is what is saved). Kept out of the screen so it is
 * tested without rendering.
 */

/** A row of the review, with the import it is in: a change to it goes to that import. */
export type ReviewRow = { importId: string; item: PhotoImportItem };

/** The imports read so far, by id. One not read yet is missing. */
export type ReadImports = Readonly<Record<string, PhotoImport>>;

export type ImportsReview = {
  /** What the review shows and the save takes, in order. */
  rows: ReviewRow[];
  /** The imports to read again: not read yet, or still reading or looking up. */
  waiting: string[];
  /** Nothing is waiting: what Next waits for, and when polling stops. */
  settled: boolean;
  /** How many photos could not be read (their import failed). */
  unread: number;
  /** Settled with no row to show: no photo had a word. */
  empty: boolean;
  /** What the review is waiting for, while it waits. */
  status: string | null;
};

export function importsReviewOf(importIds: readonly string[], imports: ReadImports): ImportsReview {
  // What the review of one import polls (shouldPollImport), and an import not read yet,
  // whose first read failed: reading it again is the retry.
  const waiting = importIds.filter((id) => imports[id] === undefined || shouldPollImport(imports[id]));
  const read = importIds.flatMap((id) => (imports[id] === undefined ? [] : [imports[id]]));
  const shown = read.filter((one) => one.status !== 'failed');
  const rows = firstRowPerGloss(
    shown.flatMap((one) => one.items.map((item) => ({ importId: one.id, item }))),
    (row) => row.item.chosen_gloss_id,
  );
  const settled = waiting.length === 0;
  return {
    rows,
    waiting,
    settled,
    unread: read.length - shown.length,
    empty: settled && rows.length === 0,
    status: settled ? null : statusOf(waiting, imports, shown),
  };
}

/** Reading while any photo is not read yet; past that, the rows looked up so far of
 *  every photo read, as one count. */
function statusOf(waiting: readonly string[], imports: ReadImports, shown: readonly PhotoImport[]): string {
  if (waiting.some((id) => imports[id] === undefined || imports[id].status === 'reading')) {
    return strings.targetReviewReading;
  }
  const count = (key: 'settled_count' | 'item_count') => shown.reduce((sum, one) => sum + one[key], 0);
  return strings.photoImportLookingUp(count('settled_count'), count('item_count'));
}

/** The imports with one of them changed, an import not read yet left alone. */
export function withImportChanged(
  imports: ReadImports,
  importId: string,
  change: (imp: PhotoImport) => PhotoImport,
): ReadImports {
  const current = imports[importId];
  return current === undefined ? imports : { ...imports, [importId]: change(current) };
}
