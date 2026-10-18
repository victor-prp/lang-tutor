import type {
  Enrollment,
  PhotoImport,
  PhotoImportCreateRequest,
  PhotoImportItem,
  PhotoImportSummary,
  SaveVocabularyResponse,
  TranslationRequest,
  TranslationResponse,
  VocabularyEntryInput,
} from '@lang-tutor/core/api';
import { firstRowPerGloss } from '@lang-tutor/core/domain';

import {
  LOOK_UP_IMPORT_ITEM,
  LookUpImportItemPayloadSchema,
  READ_PHOTO,
  RENDER_LEMMA,
  ReadPhotoPayloadSchema,
} from '../domain/jobs';
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
import { firstPerGloss } from '../domain/vocabulary';
import {
  GlossLanguageMismatch,
  InvalidPhotoImportItem,
  InvalidVocabularyEntry,
  PhotoImportConflict,
  PhotoImportNotFound,
  PhotoUnreadable,
  SenseMatchUnreadable,
} from '../errors';
import type { Logger } from '../logger';
import type { ItemResult, PhotoImportItemRow, PhotoImportRow } from '../repo/photoImports';
import { authorizeEnrollment } from './access';
import { requestStockAfterSave } from './stock';
import type { LlmClient, VisionClient } from './llm';
import type { Repos, Transaction } from './transaction';

function toItem(row: PhotoImportItemRow): PhotoImportItem {
  return {
    position: row.position,
    text: row.text,
    hebrew: row.hebrew,
    status: row.status,
    corrected_form: row.correctedForm,
    options: row.options,
    chosen_gloss_id: row.chosenGlossId,
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

/** Spec D11. An import a save may take: read, no row still being looked up, not expired. */
function readyToSave(row: PhotoImportRow, items: readonly PhotoImportItemRow[], now: number): boolean {
  return row.status === 'read' && isOpen(row.status, row.createdAt, now) && !items.some((item) => item.status === 'pending');
}

/** A ticked row's chosen sense, as a save takes it, with the import the row is in: a refused
 *  entry's log names it. */
type ImportEntry = VocabularyEntryInput & { importId: string };

/** Phase 26 (spec D14). A photo import saved: the words it gave, and what its review left, the
 *  rows unticked and the rows given another meaning than the one suggested. */
export type ImportSaved = { importId: string; savedCount: number; untickedCount: number; changedGlossCount: number };

function importSaved(importId: string, items: readonly PhotoImportItemRow[], savedCount: number): ImportSaved {
  const counts = reviewCounts(items);
  return { importId, savedCount, untickedCount: counts.unticked, changedGlossCount: counts.changedGloss };
}

/** Phase 26 (spec D14). A save of an import, logged once its transaction committed. Phase 53
 *  (final review I3): a target's save of several logs each the same way, naming the target. */
export function logImportSaved(logger: Logger, saved: ImportSaved, by: { target_id?: string } = {}): void {
  logger.info({
    event: 'photo_import_saved',
    import_id: saved.importId,
    saved_count: saved.savedCount,
    unticked_count: saved.untickedCount,
    changed_gloss_count: saved.changedGlossCount,
    ...by,
  });
}

/**
 * Spec D11. The writes of a save from photo imports, in a transaction the caller opened,
 * authorized, and locked each import in after checking it with readyToSave: the entries
 * checked as today's save checks them, inserted, their lemma renders claimed, every import
 * marked saved, and the next session in stock asked for. These writes are dependent, so a
 * refused gloss or a lost race rolls all of them back. Answers the saved gloss ids, resolved
 * through merges, in order.
 *
 * Phase 53. Shared by a save of one import and by a target's save of several
 * (saveImportsInTx), which differ only in the rows they take.
 */
async function writeImportSave(
  repos: Repos,
  logger: Logger,
  input: {
    enrolled: Enrollment;
    actorUserId: string;
    importIds: readonly string[];
    entries: readonly ImportEntry[];
    stockSaveDelaySeconds: number;
  },
): Promise<string[]> {
  const { photoImport, vocabulary, gloss, dict, jobs } = repos;
  const { enrolled, entries } = input;
  // Phase 31 (spec D14). Share-lock and resolve before anything is checked or
  // written. The rows' options are a snapshot, so a choice made before a
  // merge names a forwarded gloss: it is saved as its survivor.
  const resolved = await gloss.resolveGlosses(entries.map((entry) => entry.gloss_id));
  const foreign = entries.find((entry) => {
    const found = resolved.get(entry.gloss_id);
    return found !== undefined && found.userLanguageCode !== enrolled.source_language;
  });
  if (foreign) {
    logger.info({ event: 'photo_import_entry_refused', import_id: foreign.importId, gloss_id: foreign.gloss_id, reason: 'language' });
    throw new GlossLanguageMismatch(foreign.gloss_id);
  }
  const toSave = firstPerGloss(entries.map((entry) => ({ ...entry, gloss_id: resolved.get(entry.gloss_id)?.id ?? entry.gloss_id })));
  const saveable = await vocabulary.findSaveable({
    entries: toSave.map((entry) => ({ glossId: entry.gloss_id, variantId: entry.variant_id })),
    targetLanguage: enrolled.target_language,
    sourceLanguage: enrolled.source_language,
  });
  const passed = new Set(saveable.map((entry) => `${entry.glossId} ${entry.variantId}`));
  const refused = toSave.find((entry) => !passed.has(`${entry.gloss_id} ${entry.variant_id}`));
  if (refused) {
    // As today's save logs it: the 400 body is fixed, and an import that
    // can never be saved is diagnosed only from here.
    logger.info({
      event: 'photo_import_entry_refused',
      import_id: refused.importId,
      gloss_id: refused.gloss_id,
      variant_id: refused.variant_id,
    });
    throw new InvalidVocabularyEntry(refused.gloss_id);
  }
  // Phase 28. Only the list's owner photographs into it: no grant reaches a
  // photo import or a target (photo_import.manage and targets.manage are in no
  // role), so the actor here is the owner, who added these words. Phase 29 made
  // that true by construction: every caller's check lets only the owner here.
  await vocabulary.insertEntries({
    enrollmentId: enrolled.id,
    addedByUserId: input.actorUserId,
    entries: saveable,
  });
  // Phase 31 (spec D12). A word whose lemma form this language has not
  // rendered gets it rendered in the background, once (plan item 3).
  const claimed = await dict.claimLemmaRenders(
    saveable.map((entry) => ({ lexemeId: entry.lexemeId, userLanguageCode: enrolled.source_language })),
  );
  for (const pair of claimed) {
    await jobs.enqueue(RENDER_LEMMA, { lexeme_id: pair.lexemeId, user_language_code: pair.userLanguageCode });
  }
  for (const importId of input.importIds) {
    // Conditional: a discard that landed first wins, and the throw rolls
    // the inserts back.
    if (!(await photoImport.transition(importId, ['read'], 'saved'))) {
      throw new PhotoImportConflict(importId, 'not ready to save');
    }
  }
  // Phase 43 (spec D3, ruling R3). The next session in stock, if the list has none.
  await requestStockAfterSave(repos, enrolled.id, input.stockSaveDelaySeconds);
  return toSave.map((entry) => entry.gloss_id);
}

/**
 * Phase 53 (spec D10, D11, ruling R-D9). Several photo imports, one per photo, saved together
 * in a transaction the caller opened and authorized for `enrolled`: what a target's create or
 * add brings from photos. Each import is locked, and must be one of `enrolled`'s: else
 * PhotoImportNotFound. A failed one (its photo could not be read) is skipped and counted as a
 * photo not read. Any other must be ready, as a save of it alone must be: one reading, saved,
 * discarded or expired is PhotoImportConflict. The rows of all of them, in the order given and
 * then by position, are one review, as the app shows it: the first row of each chosen gloss
 * (firstRowPerGloss), and of those the ticked ones are saved as a save of one import saves
 * them, every import then marked saved. Answers the saved gloss ids, resolved through merges,
 * in order, the photos not read, and each import saved, for the caller to log once its
 * transaction commits (logImportSaved): its words are the entries taken from its rows. No
 * import, or only failed ones: nothing is written.
 */
export async function saveImportsInTx(
  repos: Repos,
  logger: Logger,
  input: {
    enrolled: Enrollment;
    actorUserId: string;
    importIds: readonly string[];
    now: number;
    stockSaveDelaySeconds: number;
  },
): Promise<{ glossIds: string[]; failedPhotos: number; imports: ImportSaved[] }> {
  const { photoImport } = repos;
  const joined: { importId: string; items: PhotoImportItemRow[] }[] = [];
  let failedPhotos = 0;
  // An id named twice is one import, saved once.
  for (const importId of new Set(input.importIds)) {
    const row = await photoImport.findImportForUpdate(importId);
    if (!row || row.enrollmentId !== input.enrolled.id) throw new PhotoImportNotFound(importId);
    if (row.status === 'failed') {
      failedPhotos += 1;
      continue;
    }
    const items = await photoImport.listItems(importId);
    if (!readyToSave(row, items, input.now)) throw new PhotoImportConflict(importId, 'not ready to save');
    joined.push({ importId, items });
  }
  if (joined.length === 0) return { glossIds: [], failedPhotos, imports: [] };
  const shown = firstRowPerGloss(
    joined.flatMap(({ importId, items }) => items.map((item) => ({ importId, item }))),
    ({ item }) => item.chosenGlossId,
  );
  const entries = firstPerGloss(shown.flatMap(({ importId, item }) => entriesToSave([item]).map((entry) => ({ ...entry, importId }))));
  const glossIds = await writeImportSave(repos, logger, {
    enrolled: input.enrolled,
    actorUserId: input.actorUserId,
    importIds: joined.map(({ importId }) => importId),
    entries,
    stockSaveDelaySeconds: input.stockSaveDelaySeconds,
  });
  const imports = joined.map(({ importId, items }) =>
    importSaved(importId, items, entries.filter((entry) => entry.importId === importId).length),
  );
  return { glossIds, failedPhotos, imports };
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
 *
 * Phase 29 (spec D13): every learner use case here is the list owner's alone
 * (`photo_import.manage`), checked inside its transaction before any write.
 */
export function createPhotoImportService({
  transaction,
  vision,
  llm,
  lookup,
  now,
  logger,
  stockSaveDelaySeconds,
}: {
  transaction: Transaction;
  vision: VisionClient;
  llm: LlmClient;
  lookup: (actorUserId: string, input: TranslationRequest) => Promise<TranslationResponse>;
  now: () => number;
  logger: Logger;
  /** Phase 43 (ruling R3). How long a save's request for a stock waits. */
  stockSaveDelaySeconds: number;
}) {
  /** Phase 29. An import is addressed by its own id; its list decides. */
  const authorizeImport = (repos: Repos, actorUserId: string, row: PhotoImportRow) =>
    authorizeEnrollment(repos, logger, { actorUserId, enrollmentId: row.enrollmentId, permission: 'photo_import.manage' });

  return {
    /** The upload: one transaction stores the photo and enqueues its read
     *  (ADR 0007). Creating also clears the enrollment's expired imports
     *  (spec D10). */
    create: async (
      actorUserId: string,
      enrollmentId: string,
      request: PhotoImportCreateRequest,
    ): Promise<PhotoImportSummary> => {
      const created = await transaction(async (repos) => {
        const { photoImport, jobs } = repos;
        await authorizeEnrollment(repos, logger, { actorUserId, enrollmentId, permission: 'photo_import.manage' });
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

    list: async (actorUserId: string, enrollmentId: string): Promise<PhotoImportSummary[]> =>
      transaction(async (repos) => {
        await authorizeEnrollment(repos, logger, { actorUserId, enrollmentId, permission: 'photo_import.manage' });
        const rows = await repos.photoImport.listOpen({ enrollmentId, since: new Date(now() - IMPORT_TTL_MS) });
        return rows.map((row) => ({
          id: row.id,
          status: deriveStatus(row.status, row.pendingCount),
          item_count: row.itemCount,
          settled_count: row.settledCount,
          created_at: row.createdAt.toISOString(),
        }));
      }),

    getImport: async (actorUserId: string, importId: string): Promise<PhotoImport> =>
      transaction(async (repos) => {
        const row = await repos.photoImport.findImport(importId);
        if (!row) throw new PhotoImportNotFound(importId);
        await authorizeImport(repos, actorUserId, row);
        return toImport(row, await repos.photoImport.listItems(importId));
      }),

    updateItem: async (
      actorUserId: string,
      importId: string,
      position: number,
      update: ItemUpdate,
    ): Promise<PhotoImportItem> =>
      transaction(async (repos) => {
        const { photoImport } = repos;
        const row = await photoImport.findImportForUpdate(importId);
        if (!row) throw new PhotoImportNotFound(importId);
        await authorizeImport(repos, actorUserId, row);
        if (!isOpen(row.status, row.createdAt, now())) throw new PhotoImportConflict(importId, 'not open');
        const item = await photoImport.findItem(importId, position);
        if (!item) throw new PhotoImportNotFound(importId, position);
        const refusal = refuseItemUpdate(item, update);
        if (refusal === 'not_ready') throw new PhotoImportConflict(importId, `row ${position} is not ready`);
        if (refusal) throw new InvalidPhotoImportItem(importId, position, refusal);
        const updated = await photoImport.updateItem(importId, position, {
          ...(update.ticked !== undefined ? { ticked: update.ticked } : {}),
          ...(update.gloss_id !== undefined ? { chosenGlossId: update.gloss_id } : {}),
        });
        if (!updated) throw new PhotoImportNotFound(importId, position);
        return toItem(updated);
      }),

    /**
     * Spec D11. One transaction: the entries checked as today's save checks
     * them, inserted, and the import marked saved. These writes are dependent,
     * so a refused gloss or a lost race rolls all of them back. A repeated save
     * answers the same ids and writes nothing, which covers a save whose
     * response was lost.
     *
     * Phase 53. Its writes are writeImportSave's, shared with a target's save of
     * several imports. The rows differ: this import's review shows every row, so
     * every ticked row is saved, where a target's review shows only the first
     * row of each gloss (saveImportsInTx).
     */
    save: async (actorUserId: string, importId: string): Promise<SaveVocabularyResponse> => {
      const outcome = await transaction(async (repos) => {
        const { photoImport } = repos;
        const row = await photoImport.findImportForUpdate(importId);
        if (!row) throw new PhotoImportNotFound(importId);
        const enrolled = await authorizeImport(repos, actorUserId, row);
        const items = await photoImport.listItems(importId);
        const entries = firstPerGloss(entriesToSave(items));
        if (row.status === 'saved') return { entries, items, repeated: true };
        if (!readyToSave(row, items, now())) throw new PhotoImportConflict(importId, 'not ready to save');
        await writeImportSave(repos, logger, {
          enrolled,
          actorUserId,
          importIds: [importId],
          entries: entries.map((entry) => ({ ...entry, importId })),
          stockSaveDelaySeconds,
        });
        return { entries, items, repeated: false };
      });
      if (!outcome.repeated) logImportSaved(logger, importSaved(importId, outcome.items, outcome.entries.length));
      return { saved_gloss_ids: outcome.entries.map((entry) => entry.gloss_id) };
    },

    /**
     * Phase 64 (final review I2). The photo flow's My words: the flow's imports saved in one
     * transaction, as a prep's create saves them (saveImportsInTx): the first row of each gloss
     * across the photos, the row the review shows, so a word on two photos that the review
     * unticked is not saved by its other row. A failed photo saves nothing; one not ready is
     * refused (409), and so is one already saved.
     */
    saveMany: async (actorUserId: string, enrollmentId: string, importIds: readonly string[]): Promise<SaveVocabularyResponse> => {
      const saved = await transaction(async (repos) => {
        const enrolled = await authorizeEnrollment(repos, logger, { actorUserId, enrollmentId, permission: 'photo_import.manage' });
        return saveImportsInTx(repos, logger, { enrolled, actorUserId, importIds, now: now(), stockSaveDelaySeconds });
      });
      for (const imported of saved.imports) logImportSaved(logger, imported);
      return { saved_gloss_ids: saved.glossIds };
    },

    /** Idempotent on a discarded import. A saved one is refused (409). */
    discard: async (actorUserId: string, importId: string): Promise<void> => {
      const discarded = await transaction(async (repos) => {
        const { photoImport } = repos;
        const row = await photoImport.findImportForUpdate(importId);
        if (!row) throw new PhotoImportNotFound(importId);
        await authorizeImport(repos, actorUserId, row);
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
        return enrolled
          ? { photo, target: enrolled.target_language as LanguageCode, owner: { enrollmentId: enrolled.id, userId: enrolled.user_id } }
          : undefined;
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
          // Phase 47 (spec D3, ruling R5): the photo itself is never recorded.
          record: { kind: 'photo_read', ...read.owner },
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
     * then the gloss, then one write. An import no longer open, or a row
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

      // The job has no actor of its own. It looks up for the list's owner, the
      // only one who could have made this import (photo_import.manage).
      const response = await lookup(enrolled.user_id, {
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
        result = { correctedForm, options, chosenGlossId: null, ticked: false, hebrewMismatch: false, reason: reasonFor(response) };
      } else {
        let choice = firstChoice(item.hebrew, options);
        if (choice === 'ask_model') {
          const raw = await llm({
            ...buildSenseMatchPrompt({ word: correctedForm ?? item.text, target, hebrew: item.hebrew ?? '', options }),
            record: { kind: 'sense_match', enrollmentId: enrolled.id, userId: enrolled.user_id },
          });
          const answer = parseSenseMatch(raw, options.length);
          if (answer === null) throw new SenseMatchUnreadable(importId, position);
          choice = choiceFromModel(answer);
        }
        matchedBy = choice.matchedBy;
        result = {
          correctedForm,
          options,
          chosenGlossId: options[choice.index].gloss_id,
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
