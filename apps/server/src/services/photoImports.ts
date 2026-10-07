import type {
  PhotoImport,
  PhotoImportCreateRequest,
  PhotoImportItem,
  PhotoImportSummary,
  SaveVocabularyResponse,
  TranslationRequest,
  TranslationResponse,
} from '@lang-tutor/core/api';

import { LOOK_UP_IMPORT_ITEM, LookUpImportItemPayloadSchema, READ_PHOTO, ReadPhotoPayloadSchema } from '../domain/jobs';
import type { LanguageCode } from '../domain/languages';
import { buildPhotoReadingPrompt, parsePhotoReading, type PhotoReading } from '../domain/photoReading';
import {
  IMPORT_TTL_MS,
  deriveStatus,
  entriesToSave,
  isOpen,
  optionsFrom,
  reasonFor,
  refuseItemUpdate,
  reviewCounts,
  type ItemUpdate,
} from '../domain/photoImports';
import { buildSenseMatchPrompt, choiceFromModel, firstChoice, parseSenseMatch, type MatchedBy } from '../domain/senseMatching';
import { firstPerSense } from '../domain/vocabulary';
import {
  EnrollmentNotFound,
  InvalidPhotoImportItem,
  InvalidVocabularyEntry,
  PhotoImportConflict,
  PhotoImportNotFound,
  PhotoUnreadable,
  SenseMatchUnreadable,
} from '../errors';
import type { Logger } from '../logger';
import type { ItemResult, PhotoImportItemRow, PhotoImportRow } from '../repo/photoImports';
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

    getImport: async (importId: string): Promise<PhotoImport> =>
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
        if (refused) {
          // As today's save logs it: the 400 body is fixed, and an import that
          // can never be saved is diagnosed only from here.
          logger.info({
            event: 'photo_import_entry_refused',
            import_id: importId,
            sense_id: refused.sense_id,
            variant_id: refused.variant_id,
          });
          throw new InvalidVocabularyEntry(refused.sense_id);
        }
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

    /**
     * The read-photo job (spec D2, D5): read, call the model, write. No
     * transaction is held across the call (ADR 0001 R8). The rows, the photo
     * cleared and the row jobs enqueued are dependent writes in the last
     * transaction. Any throw is a failed attempt: pg-boss retries it, then
     * dead-letters to failRead.
     */
    readPhoto: async (data: unknown): Promise<void> => {
      const { import_id: importId } = ReadPhotoPayloadSchema.parse(data);
      const read = await transaction(async ({ photoImport, enrollment }) => {
        const row = await photoImport.findImport(importId);
        // Discarded, failed or gone: nothing to read, and not a failure.
        if (!row || row.status !== 'reading') return undefined;
        const photo = await photoImport.findPhoto(importId);
        if (photo === null) return undefined;
        const enrolled = await enrollment.findById(row.enrollmentId);
        return enrolled ? { photo, target: enrolled.target_language as LanguageCode } : undefined;
      });
      if (!read) {
        logger.info({ event: 'photo_read_dropped', import_id: importId, stage: 'read' });
        return;
      }

      const started = now();
      let reading: PhotoReading;
      try {
        const raw = await vision({
          ...buildPhotoReadingPrompt(read.target),
          image: { data: read.photo, mimeType: 'image/jpeg' },
        });
        // An empty string is the provider's "no content": no words, not a failure.
        const parsed = raw === '' ? { items: [], mergedCount: 0, droppedCount: 0 } : parsePhotoReading(raw);
        if (!parsed) throw new PhotoUnreadable(importId);
        reading = parsed;
      } catch (error) {
        logger.info({
          event: 'photo_read_attempt_failed',
          import_id: importId,
          read_ms: now() - started,
          reason: error instanceof Error ? error.name : 'unknown',
        });
        throw error;
      }
      const readMs = now() - started;

      const items = reading.items.map((item, position) => ({ position, text: item.text, hebrew: item.hebrew }));
      const written = await transaction(async ({ photoImport, jobs }) => {
        // Conditional: a discard during the call wins, and nothing is written.
        if (!(await photoImport.transition(importId, ['reading'], 'read'))) return false;
        await photoImport.insertItems(importId, items);
        for (const item of items) {
          await jobs.enqueue(LOOK_UP_IMPORT_ITEM, { import_id: importId, position: item.position });
        }
        return true;
      });
      logger.info({
        event: written ? 'photo_read' : 'photo_read_dropped',
        import_id: importId,
        item_count: items.length,
        hebrew_count: items.filter((item) => item.hebrew !== null).length,
        merged_count: reading.mergedCount,
        dropped_count: reading.droppedCount,
        read_ms: readMs,
        ...(written ? {} : { stage: 'write' }),
      });
    },

    /** The read's dead letter: retries spent or expired. Clears the photo
     *  (the transition always does), so a failed import keeps none. */
    failRead: async (data: unknown): Promise<void> => {
      const { import_id: importId } = ReadPhotoPayloadSchema.parse(data);
      const marked = await transaction(({ photoImport }) => photoImport.transition(importId, ['reading'], 'failed'));
      logger.info({ event: 'photo_read_failed', import_id: importId, marked });
    },

    /**
     * The look-up-import-item job (spec D7): the lookup exactly as if typed,
     * then the sense, then one write. An import no longer open, or a row
     * already settled, costs no lookup (spec D2).
     */
    lookUpItem: async (data: unknown): Promise<void> => {
      const { import_id: importId, position } = LookUpImportItemPayloadSchema.parse(data);
      const read = await transaction(async ({ photoImport, enrollment }) => {
        const row = await photoImport.findImport(importId);
        if (!row || row.status !== 'read' || !isOpen(row.status, row.createdAt, now())) return undefined;
        const item = await photoImport.findItem(importId, position);
        if (!item || item.status !== 'pending') return undefined;
        const enrolled = await enrollment.findById(row.enrollmentId);
        return enrolled ? { item, enrolled } : undefined;
      });
      if (!read) {
        logger.info({ event: 'import_item_dropped', import_id: importId, position, stage: 'read' });
        return;
      }
      const { item, enrolled } = read;
      const target = enrolled.target_language as LanguageCode;

      const response = await lookup({
        text: item.text,
        from: target,
        to: enrolled.source_language as LanguageCode,
        enrollment_id: enrolled.id,
      });
      const correctedForm = response.correction?.corrected_form ?? null;
      const options = optionsFrom(response.senses);

      let result: ItemResult;
      let matchedBy: MatchedBy | null = null;
      if (options.length === 0) {
        result = { correctedForm, options, chosenSenseId: null, ticked: false, hebrewMismatch: false, reason: reasonFor(response) };
      } else {
        let choice = firstChoice(item.hebrew, options);
        if (choice === 'ask_model') {
          const raw = await llm(
            buildSenseMatchPrompt({ word: correctedForm ?? item.text, target, hebrew: item.hebrew ?? '', options }),
          );
          const answer = parseSenseMatch(raw, options.length);
          if (answer === null) throw new SenseMatchUnreadable(importId, position);
          choice = choiceFromModel(answer);
        }
        matchedBy = choice.matchedBy;
        result = {
          correctedForm,
          options,
          chosenSenseId: options[choice.index].sense_id,
          ticked: true,
          hebrewMismatch: choice.mismatch,
          reason: null,
        };
      }

      const written = await transaction(({ photoImport }) => photoImport.writeItem(importId, position, result));
      logger.info({
        event: written ? 'import_item_looked_up' : 'import_item_dropped',
        import_id: importId,
        position,
        matched_by: matchedBy,
        corrected: correctedForm !== null,
        option_count: options.length,
        reason: result.reason,
        ...(written ? {} : { stage: 'write' }),
      });
    },

    /** The row's dead letter: the row is marked failed, the rest unaffected. */
    failItem: async (data: unknown): Promise<void> => {
      const { import_id: importId, position } = LookUpImportItemPayloadSchema.parse(data);
      const marked = await transaction(({ photoImport }) => photoImport.markItemFailed(importId, position));
      logger.info({ event: 'import_item_failed', import_id: importId, position, marked });
    },
  };
}

export type PhotoImportService = ReturnType<typeof createPhotoImportService>;
