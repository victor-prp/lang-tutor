import { describe, expect, it } from '@jest/globals';
import type { Enrollment } from '@lang-tutor/core/api';

import { IMPORT_TTL_MS } from '../domain/photoImports';
import { READ_PHOTO } from '../domain/jobs';
import { EnrollmentNotFound, InvalidPhotoImportItem, InvalidVocabularyEntry, PhotoImportConflict, PhotoImportNotFound } from '../errors';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { PhotoImportItemRow, PhotoImportRepo, PhotoImportRow } from '../repo/photoImports';
import type { VocabularyRepo } from '../repo/vocabulary';
import {
  createFakeClock,
  createFakeJobRepo,
  createFakeLlmClient,
  createFakeLogger,
  createFakeTransaction,
  stub,
} from '../../tests/support/fakes';
import type { Repos } from './transaction';
import { createPhotoImportService } from './photoImports';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const ENROLLMENT: Enrollment = { id: 'e1', source_language: 'he', target_language: 'it' } as Enrollment;
const ID = '11111111-1111-1111-1111-111111111111';

const importRow = (over: Partial<PhotoImportRow> = {}): PhotoImportRow => ({
  id: ID,
  enrollmentId: 'e1',
  status: 'read',
  photo: null,
  createdAt: new Date(NOW - 60_000),
  ...over,
});
const option = (n: number) => ({ sense_id: `s${n}`, variant_id: `v${n}`, translation: `t${n}` });
const itemRow = (over: Partial<PhotoImportItemRow> = {}): PhotoImportItemRow => ({
  importId: ID,
  position: 0,
  text: 'gatto',
  hebrew: null,
  status: 'ready',
  correctedForm: null,
  options: [option(1), option(2)],
  suggestedSenseId: 's1',
  chosenSenseId: 's1',
  ticked: true,
  hebrewMismatch: false,
  reason: null,
  ...over,
});

function setup(repos: Partial<Repos>) {
  const logger = createFakeLogger();
  const service = createPhotoImportService({
    transaction: createFakeTransaction(repos),
    vision: async () => {
      throw new Error('vision is not called by these use cases');
    },
    llm: createFakeLlmClient(''),
    lookup: async () => {
      throw new Error('lookup is not called by these use cases');
    },
    now: createFakeClock(NOW),
    logger,
  });
  return { service, logger };
}

const enrollmentRepo = (found: Enrollment | undefined) => stub<EnrollmentRepo>({ findById: async () => found });

describe('create', () => {
  it('stores the photo, clears expired imports and enqueues the read in the same transaction', async () => {
    const jobs = createFakeJobRepo();
    const calls: unknown[] = [];
    const photoImport = stub<PhotoImportRepo>({
      deleteExpired: async (input) => {
        calls.push(['deleteExpired', input]);
        return 0;
      },
      insertImport: async (input) => {
        calls.push(['insertImport', input]);
        return { id: ID, createdAt: new Date(NOW) };
      },
    });
    const { service, logger } = setup({ enrollment: enrollmentRepo(ENROLLMENT), photoImport, jobs });

    const summary = await service.create('e1', { mime_type: 'image/jpeg', image: 'QUJD' });

    expect(summary).toEqual({ id: ID, status: 'reading', item_count: 0, settled_count: 0, created_at: new Date(NOW).toISOString() });
    expect(calls).toEqual([
      ['deleteExpired', { enrollmentId: 'e1', before: new Date(NOW - IMPORT_TTL_MS) }],
      ['insertImport', { enrollmentId: 'e1', photo: 'QUJD' }],
    ]);
    expect(jobs.enqueued).toEqual([{ name: READ_PHOTO, data: { import_id: ID } }]);
    expect(logger.events).toContainEqual({ event: 'photo_import_created', import_id: ID, enrollment_id: 'e1', bytes: 4 });
    expect(JSON.stringify(logger.events)).not.toContain('QUJD');
  });

  it('refuses an unknown enrollment and enqueues nothing', async () => {
    const jobs = createFakeJobRepo();
    const { service } = setup({ enrollment: enrollmentRepo(undefined), photoImport: stub<PhotoImportRepo>({}), jobs });
    await expect(service.create('nope', { mime_type: 'image/jpeg', image: 'QUJD' })).rejects.toBeInstanceOf(EnrollmentNotFound);
    expect(jobs.enqueued).toEqual([]);
  });
});

describe('get', () => {
  it('derives looking_up while a row is pending, and counts settled rows', async () => {
    const photoImport = stub<PhotoImportRepo>({
      findImport: async () => importRow(),
      listItems: async () => [itemRow(), itemRow({ position: 1, status: 'pending', options: [], chosenSenseId: null, suggestedSenseId: null, ticked: false })],
    });
    const { service } = setup({ photoImport });
    const found = await service.getImport(ID);
    expect(found).toMatchObject({ id: ID, status: 'looking_up', item_count: 2, settled_count: 1 });
    expect(found.items[0]).toEqual({
      position: 0, text: 'gatto', hebrew: null, status: 'ready', corrected_form: null,
      options: [option(1), option(2)], chosen_sense_id: 's1', ticked: true, hebrew_mismatch: false, reason: null,
    });
  });

  it('answers PhotoImportNotFound for a missing import', async () => {
    const { service } = setup({ photoImport: stub<PhotoImportRepo>({ findImport: async () => null }) });
    await expect(service.getImport(ID)).rejects.toBeInstanceOf(PhotoImportNotFound);
  });
});

describe('updateItem', () => {
  const repoWith = (item: PhotoImportItemRow, row: PhotoImportRow = importRow()) => {
    const updates: unknown[] = [];
    const photoImport = stub<PhotoImportRepo>({
      findImportForUpdate: async () => row,
      findItem: async () => item,
      updateItem: async (_id, _position, update) => {
        updates.push(update);
        return { ...item, ...(update.ticked !== undefined ? { ticked: update.ticked } : {}), ...(update.chosenSenseId ? { chosenSenseId: update.chosenSenseId } : {}) };
      },
    });
    return { photoImport, updates };
  };

  it('switches the sense and unticks', async () => {
    const { photoImport, updates } = repoWith(itemRow());
    const { service } = setup({ photoImport });
    const item = await service.updateItem(ID, 0, { sense_id: 's2', ticked: false });
    expect(updates).toEqual([{ chosenSenseId: 's2', ticked: false }]);
    expect(item).toMatchObject({ chosen_sense_id: 's2', ticked: false });
  });

  it('refuses any change to a row whose lookup has not landed, and writes nothing (Review Focus 2)', async () => {
    const { photoImport, updates } = repoWith(itemRow({ status: 'pending' }));
    const { service } = setup({ photoImport });
    await expect(service.updateItem(ID, 0, { ticked: false })).rejects.toBeInstanceOf(PhotoImportConflict);
    expect(updates).toEqual([]);
  });

  it('refuses a sense outside the options as an invalid row change', async () => {
    const { photoImport } = repoWith(itemRow());
    const { service } = setup({ photoImport });
    await expect(service.updateItem(ID, 0, { sense_id: 's9' })).rejects.toBeInstanceOf(InvalidPhotoImportItem);
  });

  it('refuses a change to a discarded or expired import', async () => {
    for (const row of [importRow({ status: 'discarded' }), importRow({ createdAt: new Date(NOW - IMPORT_TTL_MS) })]) {
      const { photoImport } = repoWith(itemRow(), row);
      const { service } = setup({ photoImport });
      await expect(service.updateItem(ID, 0, { ticked: false })).rejects.toBeInstanceOf(PhotoImportConflict);
    }
  });

  it('answers PhotoImportNotFound for a row that does not exist', async () => {
    const photoImport = stub<PhotoImportRepo>({ findImportForUpdate: async () => importRow(), findItem: async () => null });
    const { service } = setup({ photoImport });
    await expect(service.updateItem(ID, 9, { ticked: false })).rejects.toBeInstanceOf(PhotoImportNotFound);
  });
});

describe('save', () => {
  const saveable = (n: number) => ({ senseId: `s${n}`, variantId: `v${n}`, lexemeId: `l${n}`, lemma: `w${n}` });

  it('saves the ticked rows’ chosen senses, marks the import saved, and logs how the review changed them', async () => {
    const inserted: unknown[] = [];
    const transitions: unknown[] = [];
    const items = [
      itemRow({ position: 0 }),
      itemRow({ position: 1, chosenSenseId: 's2' }),
      itemRow({ position: 2, ticked: false }),
    ];
    const photoImport = stub<PhotoImportRepo>({
      findImportForUpdate: async () => importRow(),
      listItems: async () => items,
      transition: async (...args) => {
        transitions.push(args);
        return true;
      },
    });
    const vocabulary = stub<VocabularyRepo>({
      findSaveable: async () => [saveable(1), saveable(2)],
      insertEntries: async (input) => {
        inserted.push(input);
      },
    });
    const { service, logger } = setup({ photoImport, vocabulary, enrollment: enrollmentRepo(ENROLLMENT) });

    expect(await service.save(ID)).toEqual({ saved_sense_ids: ['s1', 's2'] });
    expect(inserted).toEqual([{ enrollmentId: 'e1', entries: [saveable(1), saveable(2)] }]);
    expect(transitions).toEqual([[ID, ['read'], 'saved']]);
    expect(logger.events).toContainEqual({ event: 'photo_import_saved', import_id: ID, saved_count: 2, unticked_count: 1, changed_sense_count: 1 });
  });

  it('answers a repeated save with the same ids and writes nothing', async () => {
    const photoImport = stub<PhotoImportRepo>({ findImportForUpdate: async () => importRow({ status: 'saved' }), listItems: async () => [itemRow()] });
    const { service } = setup({ photoImport, vocabulary: stub<VocabularyRepo>({}) });
    expect(await service.save(ID)).toEqual({ saved_sense_ids: ['s1'] });
  });

  it('refuses a save while a row is pending, or once discarded', async () => {
    for (const [row, items] of [
      [importRow(), [itemRow(), itemRow({ position: 1, status: 'pending' })]],
      [importRow({ status: 'discarded' }), [itemRow()]],
      [importRow({ status: 'reading' }), []],
    ] as const) {
      const photoImport = stub<PhotoImportRepo>({ findImportForUpdate: async () => row, listItems: async () => [...items] });
      const { service } = setup({ photoImport, vocabulary: stub<VocabularyRepo>({}) });
      await expect(service.save(ID)).rejects.toBeInstanceOf(PhotoImportConflict);
    }
  });

  it('is all or nothing: a refused sense throws before anything is written', async () => {
    const photoImport = stub<PhotoImportRepo>({ findImportForUpdate: async () => importRow(), listItems: async () => [itemRow()] });
    const vocabulary = stub<VocabularyRepo>({ findSaveable: async () => [] });
    const { service } = setup({ photoImport, vocabulary, enrollment: enrollmentRepo(ENROLLMENT) });
    await expect(service.save(ID)).rejects.toBeInstanceOf(InvalidVocabularyEntry);
  });

  it('refuses when a discard won the race to the final transition', async () => {
    const photoImport = stub<PhotoImportRepo>({
      findImportForUpdate: async () => importRow(),
      listItems: async () => [itemRow()],
      transition: async () => false,
    });
    const vocabulary = stub<VocabularyRepo>({ findSaveable: async () => [saveable(1)], insertEntries: async () => undefined });
    const { service } = setup({ photoImport, vocabulary, enrollment: enrollmentRepo(ENROLLMENT) });
    await expect(service.save(ID)).rejects.toBeInstanceOf(PhotoImportConflict);
  });
});

describe('discard', () => {
  it('discards an open import, and a second discard changes nothing', async () => {
    const transitions: unknown[] = [];
    const repoFor = (row: PhotoImportRow) =>
      stub<PhotoImportRepo>({
        findImportForUpdate: async () => row,
        transition: async (...args) => {
          transitions.push(args);
          return true;
        },
      });
    await setup({ photoImport: repoFor(importRow({ status: 'reading' })) }).service.discard(ID);
    await setup({ photoImport: repoFor(importRow({ status: 'discarded' })) }).service.discard(ID);
    expect(transitions).toEqual([[ID, ['reading', 'read', 'failed'], 'discarded']]);
  });

  it('refuses to discard a saved import', async () => {
    const { service } = setup({ photoImport: stub<PhotoImportRepo>({ findImportForUpdate: async () => importRow({ status: 'saved' }) }) });
    await expect(service.discard(ID)).rejects.toBeInstanceOf(PhotoImportConflict);
  });
});
