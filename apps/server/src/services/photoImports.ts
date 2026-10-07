import type {
  PhotoImport,
  PhotoImportCreateRequest,
  PhotoImportItem,
  PhotoImportSummary,
  SaveVocabularyResponse,
  TranslationRequest,
  TranslationResponse,
} from '@lang-tutor/core/api';

import { READ_PHOTO } from '../domain/jobs';
import {
  IMPORT_TTL_MS,
  deriveStatus,
  entriesToSave,
  isOpen,
  refuseItemUpdate,
  reviewCounts,
  type ItemUpdate,
} from '../domain/photoImports';
import { firstPerSense } from '../domain/vocabulary';
import {
  EnrollmentNotFound,
  InvalidPhotoImportItem,
  InvalidVocabularyEntry,
  PhotoImportConflict,
  PhotoImportNotFound,
} from '../errors';
import type { Logger } from '../logger';
import type { PhotoImportItemRow, PhotoImportRow } from '../repo/photoImports';
import type { LlmClient, VisionClient } from './llm';
import type { Transaction } from './transaction';

function toItem(row: PhotoImportItemRow): PhotoImportItem {
  return {
    position: row.position,
    text: row.text,
    hebrew: row.hebrew,
    status: row.status,
    corrected_form: row.correctedForm,
    options: row.options,
    chosen_sense_id: row.chosenSenseId,
    ticked: row.ticked,
    hebrew_mismatch: row.hebrewMismatch,
    reason: row.reason,
  };
}

function toImport(row: PhotoImportRow, items: PhotoImportItemRow[]): PhotoImport {
  const pending = items.filter((item) => item.status === 'pending').length;
  return {
    id: row.id,
    status: deriveStatus(row.status, pending),
    item_count: items.length,
    settled_count: items.length - pending,
    created_at: row.createdAt.toISOString(),
    items: items.map(toItem),
  };
}

/**
 * Phase 26. Words from a photo: an import's use cases. The learner's are here.
 * The two the queues call (readPhoto, lookUpItem) and their dead-letter
 * handlers follow (spec D2).
 *
 * `lookup` is today's lookup use case, TranslationService['translate'], handed
 * over by the composition root as a closure (spec D7). Its dictionary writes
 * are its own independent, idempotent transactions (ADR 0001 R8). The one
 * dependent write a row job makes is the row itself.
 */
export function createPhotoImportService({
  transaction,
  vision,
  llm,
  lookup,
  now,
  logger,
}: {
  transaction: Transaction;
  vision: VisionClient;
  llm: LlmClient;
  lookup: (input: TranslationRequest) => Promise<TranslationResponse>;
  now: () => number;
  logger: Logger;
}) {
  return {
    /** The upload: one transaction stores the photo and enqueues its read
     *  (ADR 0007). Creating also clears the enrollment's expired imports
     *  (spec D10). */
    create: async (enrollmentId: string, request: PhotoImportCreateRequest): Promise<PhotoImportSummary> => {
      const created = await transaction(async ({ enrollment, photoImport, jobs }) => {
        if (!(await enrollment.findById(enrollmentId))) throw new EnrollmentNotFound(enrollmentId);
        await photoImport.deleteExpired({ enrollmentId, before: new Date(now() - IMPORT_TTL_MS) });
        const row = await photoImport.insertImport({ enrollmentId, photo: request.image });
        await jobs.enqueue(READ_PHOTO, { import_id: row.id });
        return row;
      });
      logger.info({
        event: 'photo_import_created',
        import_id: created.id,
        enrollment_id: enrollmentId,
        bytes: request.image.length,
      });
      return {
        id: created.id,
        status: 'reading',
        item_count: 0,
        settled_count: 0,
        created_at: created.createdAt.toISOString(),
      };
    },

    list: async (enrollmentId: string): Promise<PhotoImportSummary[]> =>
      transaction(async ({ enrollment, photoImport }) => {
        if (!(await enrollment.findById(enrollmentId))) throw new EnrollmentNotFound(enrollmentId);
        const rows = await photoImport.listOpen({ enrollmentId, since: new Date(now() - IMPORT_TTL_MS) });
        return rows.map((row) => ({
          id: row.id,
          status: deriveStatus(row.status, row.pendingCount),
          item_count: row.itemCount,
          settled_count: row.settledCount,
          created_at: row.createdAt.toISOString(),
        }));
      }),

    get: async (importId: string): Promise<PhotoImport> =>
      transaction(async ({ photoImport }) => {
        const row = await photoImport.findImport(importId);
        if (!row) throw new PhotoImportNotFound(importId);
        return toImport(row, await photoImport.listItems(importId));
      }),

    updateItem: async (importId: string, position: number, update: ItemUpdate): Promise<PhotoImportItem> =>
      transaction(async ({ photoImport }) => {
        const row = await photoImport.findImportForUpdate(importId);
        if (!row) throw new PhotoImportNotFound(importId);
        if (!isOpen(row.status, row.createdAt, now())) throw new PhotoImportConflict(importId, 'not open');
        const item = await photoImport.findItem(importId, position);
        if (!item) throw new PhotoImportNotFound(importId, position);
        const refusal = refuseItemUpdate(item, update);
        if (refusal === 'not_ready') throw new PhotoImportConflict(importId, `row ${position} is not ready`);
        if (refusal) throw new InvalidPhotoImportItem(importId, position, refusal);
        const updated = await photoImport.updateItem(importId, position, {
          ...(update.ticked !== undefined ? { ticked: update.ticked } : {}),
          ...(update.sense_id !== undefined ? { chosenSenseId: update.sense_id } : {}),
        });
        if (!updated) throw new PhotoImportNotFound(importId, position);
        return toItem(updated);
      }),

    /**
     * Spec D11. One transaction: the entries checked as today's save checks
     * them, inserted, and the import marked saved. These writes are dependent,
     * so a refused sense or a lost race rolls all of them back. A repeated save
     * answers the same ids and writes nothing, which covers a save whose
     * response was lost.
     */
    save: async (importId: string): Promise<SaveVocabularyResponse> => {
      const outcome = await transaction(async ({ photoImport, enrollment, vocabulary }) => {
        const row = await photoImport.findImportForUpdate(importId);
        if (!row) throw new PhotoImportNotFound(importId);
        const items = await photoImport.listItems(importId);
        const entries = firstPerSense(entriesToSave(items));
        if (row.status === 'saved') return { entries, items, repeated: true };
        const ready =
          row.status === 'read' &&
          isOpen(row.status, row.createdAt, now()) &&
          !items.some((item) => item.status === 'pending');
        if (!ready) throw new PhotoImportConflict(importId, 'not ready to save');

        const enrolled = await enrollment.findById(row.enrollmentId);
        if (!enrolled) throw new EnrollmentNotFound(row.enrollmentId);
        const saveable = await vocabulary.findSaveable({
          entries: entries.map((entry) => ({ senseId: entry.sense_id, variantId: entry.variant_id })),
          targetLanguage: enrolled.target_language,
          sourceLanguage: enrolled.source_language,
        });
        const passed = new Set(saveable.map((entry) => `${entry.senseId} ${entry.variantId}`));
        const refused = entries.find((entry) => !passed.has(`${entry.sense_id} ${entry.variant_id}`));
        if (refused) throw new InvalidVocabularyEntry(refused.sense_id);
        await vocabulary.insertEntries({ enrollmentId: row.enrollmentId, entries: saveable });
        // Conditional: a discard that landed first wins, and the throw rolls
        // the inserts back.
        if (!(await photoImport.transition(importId, ['read'], 'saved'))) {
          throw new PhotoImportConflict(importId, 'not ready to save');
        }
        return { entries, items, repeated: false };
      });
      if (!outcome.repeated) {
        const counts = reviewCounts(outcome.items);
        logger.info({
          event: 'photo_import_saved',
          import_id: importId,
          saved_count: outcome.entries.length,
          unticked_count: counts.unticked,
          changed_sense_count: counts.changedSense,
        });
      }
      return { saved_sense_ids: outcome.entries.map((entry) => entry.sense_id) };
    },

    /** Idempotent on a discarded import. A saved one is refused (409). */
    discard: async (importId: string): Promise<void> => {
      const discarded = await transaction(async ({ photoImport }) => {
        const row = await photoImport.findImportForUpdate(importId);
        if (!row) throw new PhotoImportNotFound(importId);
        if (row.status === 'discarded') return false;
        if (row.status === 'saved') throw new PhotoImportConflict(importId, 'already saved');
        if (await photoImport.transition(importId, ['reading', 'read', 'failed'], 'discarded')) return true;
        // Lost a race: to another discard (fine), or to a save (refused).
        const after = await photoImport.findImport(importId);
        if (after?.status === 'discarded') return false;
        throw new PhotoImportConflict(importId, 'already saved');
      });
      if (discarded) logger.info({ event: 'photo_import_discarded', import_id: importId });
    },
  };
}

export type PhotoImportService = ReturnType<typeof createPhotoImportService>;
