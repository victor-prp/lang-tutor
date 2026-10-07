import type {
  PhotoImport,
  PhotoImportItem,
  PhotoImportItemUpdate,
  PhotoImportOption,
  PhotoImportStatus,
  PhotoImportSummary,
} from '@lang-tutor/core/api';

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
