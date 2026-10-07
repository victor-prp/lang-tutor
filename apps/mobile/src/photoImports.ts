import type {
  PhotoImport,
  PhotoImportItem,
  PhotoImportItemReason,
  PhotoImportItemUpdate,
  PhotoImportOption,
  PhotoImportStatus,
  PhotoImportSummary,
} from '@lang-tutor/core/api';

import { ApiError } from '@/api/client';
import { strings } from '@/strings';

/** Phase 26 (spec D13). The review's rules, kept out of the screen so they are
 *  tested without rendering. */

export const IMPORT_POLL_INTERVAL_MS = 2_000;

export const isWorking = (status: PhotoImportStatus): boolean => status === 'reading' || status === 'looking_up';

export const shouldPollImport = (imp: PhotoImport | null): boolean => imp !== null && isWorking(imp.status);

export const tickedCount = (imp: PhotoImport): number =>
  imp.items.filter((item) => item.status === 'ready' && item.ticked).length;

export const canSave = (imp: PhotoImport): boolean => imp.status === 'ready' && tickedCount(imp) > 0;

export const chosenOption = (item: PhotoImportItem): PhotoImportOption | null =>
  item.options.find((option) => option.sense_id === item.chosen_sense_id) ?? null;

/** The status line of an import, on the review and in the list of open ones.
 *  A saved or discarded import has none: there is nothing left to wait for. */
export function statusLabel(summary: PhotoImportSummary): string | null {
  switch (summary.status) {
    case 'reading':
      return strings.photoImportReading;
    case 'looking_up':
      return strings.photoImportLookingUp(summary.settled_count, summary.item_count);
    case 'ready':
      return strings.photoImportReady;
    case 'failed':
      return strings.photoImportFailed;
    case 'saved':
    case 'discarded':
      return null;
  }
}

const REASONS: Record<PhotoImportItemReason, string> = {
  sentence: strings.photoImportReasonSentence,
  no_meaning: strings.photoImportReasonNoMeaning,
  not_in_language: strings.photoImportReasonNotInLanguage,
};

/** What a row says under its word: what the photo had when the lookup corrected
 *  it, the printed Hebrew when it named none of the senses, and why a row has
 *  nothing to save. */
export function rowNotes(item: PhotoImportItem): string[] {
  const notes: string[] = [];
  if (item.corrected_form !== null) notes.push(strings.photoImportReadAs(item.text));
  if (item.hebrew_mismatch && item.hebrew !== null) notes.push(strings.photoImportListSays(item.hebrew));
  if (item.reason !== null) notes.push(REASONS[item.reason]);
  if (item.status === 'failed') notes.push(strings.photoImportRowFailed);
  return notes;
}

/** The optimistic copy of a change, before the server answers. */
export function withChange(imp: PhotoImport, position: number, change: PhotoImportItemUpdate): PhotoImport {
  return {
    ...imp,
    items: imp.items.map((item) =>
      item.position !== position
        ? item
        : {
            ...item,
            ...(change.ticked !== undefined ? { ticked: change.ticked } : {}),
            ...(change.sense_id !== undefined ? { chosen_sense_id: change.sense_id } : {}),
          },
    ),
  };
}

/** A poll's answer, minus the rows whose change has not landed yet, so a
 *  stale poll never undoes a tap. */
export function mergePolled(polled: PhotoImport, local: PhotoImport, inFlight: ReadonlySet<number>): PhotoImport {
  if (inFlight.size === 0) return polled;
  const mine = new Map(local.items.map((item) => [item.position, item]));
  return {
    ...polled,
    items: polled.items.map((item) => (inFlight.has(item.position) ? (mine.get(item.position) ?? item) : item)),
  };
}

/** What a row change that failed leaves behind. An ApiError is the server's
 *  answer: it refused, so nothing changed there and the row is put back. Any
 *  other failure (no network, a lost response) may have landed, so the row stops
 *  being kept local and the server's copy is read and adopted. */
export function afterFailedChange(error: unknown): 'revert' | 'adopt_server' {
  return error instanceof ApiError ? 'revert' : 'adopt_server';
}

/** How a read of the import ended: its answer shown, dropped because a newer
 *  answer was already shown, or the read itself failed. */
export type ReadOutcome = 'applied' | 'superseded' | 'failed';

/** After a change with no answer, what its read-back decides for the row, which
 *  is held until then. A read that landed (this one or a newer one) has put the
 *  server's row on screen, so the row is released. A read that failed too means
 *  no network: the change almost certainly never arrived, and the row goes
 *  back to what it was. */
export function afterReadBack(outcome: ReadOutcome): 'release' | 'revert' {
  return outcome === 'failed' ? 'revert' : 'release';
}

/** What a save left saved, read back from the import: null unless it is saved.
 *  Counted as the server's save counts it (spec D11), one word per chosen sense
 *  of a ticked row, so a save whose answer was lost still ends with its count. */
export function savedWordCount(imp: PhotoImport | null): number | null {
  if (imp?.status !== 'saved') return null;
  const senses = new Set(
    imp.items
      .filter((item) => item.status === 'ready' && item.ticked && chosenOption(item) !== null)
      .map((item) => item.chosen_sense_id),
  );
  return senses.size;
}

export type StoredImports = { enrollmentId: string; imports: PhotoImportSummary[] };

const NO_IMPORTS: PhotoImportSummary[] = [];

/** The active enrollment's open imports. A list read for any other enrollment
 *  (a slow answer that landed after a switch) is never shown. Keyed rather than
 *  cleared on a switch, as useNextSession is: a clearing effect in the provider
 *  runs after home's own focus effect (children first) and discards its read. */
export function importsFor(stored: StoredImports | null, activeId: string | undefined): PhotoImportSummary[] {
  return stored !== null && stored.enrollmentId === activeId ? stored.imports : NO_IMPORTS;
}

export type HomePhotoCard =
  | { kind: 'working'; id: string }
  | { kind: 'ready'; id: string; count: number }
  | { kind: 'failed'; id: string }
  | { kind: 'several'; count: number }
  | null;

/** What home's card says (spec D13): nothing, the one import, or how many. */
export function homePhotoCard(imports: readonly PhotoImportSummary[]): HomePhotoCard {
  if (imports.length === 0) return null;
  if (imports.length > 1) return { kind: 'several', count: imports.length };
  const [only] = imports;
  if (isWorking(only.status)) return { kind: 'working', id: only.id };
  if (only.status === 'failed') return { kind: 'failed', id: only.id };
  return { kind: 'ready', id: only.id, count: only.item_count };
}
