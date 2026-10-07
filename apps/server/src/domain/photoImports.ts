import type {
  PhotoImportItemReason,
  PhotoImportOption,
  PhotoImportStatus,
  TranslationGuardReason,
  TranslationKind,
  TranslationSense,
  VocabularyEntryInput,
} from '@lang-tutor/core/api';

/**
 * Phase 26. The rules of an import that need no database: its status as the
 * app sees it, whether it is still open, which changes a row accepts, and what
 * saving it writes (spec D4, D9–D11).
 */

export type StoredImportStatus = 'reading' | 'read' | 'failed' | 'saved' | 'discarded';
export type StoredItemStatus = 'pending' | 'ready' | 'failed';

/** Spec D10: an import nobody opens for 14 days is gone. */
export const IMPORT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** What the rules read from a row. The repository's row type has more. */
export type ImportItemState = {
  position: number;
  status: StoredItemStatus;
  options: PhotoImportOption[];
  suggestedSenseId: string | null;
  chosenSenseId: string | null;
  ticked: boolean;
};

/** "Ready to review" is never stored (spec D4). */
export function deriveStatus(stored: StoredImportStatus, pendingCount: number): PhotoImportStatus {
  if (stored === 'read') return pendingCount > 0 ? 'looking_up' : 'ready';
  return stored;
}

/** `now` is received: domain/ never reads a clock (ADR 0001 R3). */
export function isOpen(stored: StoredImportStatus, createdAt: Date, now: number): boolean {
  return stored !== 'saved' && stored !== 'discarded' && now - createdAt.getTime() < IMPORT_TTL_MS;
}

export type ItemUpdate = { ticked?: boolean; sense_id?: string };
export type ItemUpdateRefusal = 'not_ready' | 'no_options' | 'unknown_sense';

/** `not_ready` is a 409, because the row is still being looked up or failed.
 *  The other two are 400s. */
export function refuseItemUpdate(item: ImportItemState, update: ItemUpdate): ItemUpdateRefusal | null {
  if (item.status !== 'ready') return 'not_ready';
  if (update.sense_id !== undefined && !item.options.some((option) => option.sense_id === update.sense_id)) {
    return 'unknown_sense';
  }
  if (update.ticked === true && item.options.length === 0) return 'no_options';
  return null;
}

/** The ticked rows' chosen senses, as today's save takes them. */
export function entriesToSave(items: readonly ImportItemState[]): VocabularyEntryInput[] {
  return items.flatMap((item) => {
    if (item.status !== 'ready' || !item.ticked || item.chosenSenseId === null) return [];
    const option = item.options.find((candidate) => candidate.sense_id === item.chosenSenseId);
    return option ? [{ sense_id: option.sense_id, variant_id: option.variant_id }] : [];
  });
}

/** Spec D14: how often the default was changed, among rows that had one. */
export function reviewCounts(items: readonly ImportItemState[]): { unticked: number; changedSense: number } {
  const offered = items.filter((item) => item.status === 'ready' && item.options.length > 0);
  return {
    unticked: offered.filter((item) => !item.ticked).length,
    changedSense: offered.filter((item) => item.chosenSenseId !== item.suggestedSenseId).length,
  };
}

/** A lookup's saveable senses, in its order: the order a typed lookup lists. */
export function optionsFrom(senses: readonly TranslationSense[]): PhotoImportOption[] {
  return senses.flatMap((sense) =>
    sense.sense_id && sense.variant_id
      ? [
          {
            sense_id: sense.sense_id,
            variant_id: sense.variant_id,
            translation: sense.translation,
            ...(sense.part_of_speech ? { part_of_speech: sense.part_of_speech } : {}),
            ...(sense.example ? { example: sense.example } : {}),
          },
        ]
      : [],
  );
}

/** Why a looked-up row has no options. */
export function reasonFor(response: { kind: TranslationKind; reason?: TranslationGuardReason }): PhotoImportItemReason {
  if (response.reason) return 'not_in_language';
  if (response.kind === 'sentence') return 'sentence';
  return 'no_meaning';
}
