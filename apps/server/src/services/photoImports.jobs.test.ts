import { describe, expect, it } from '@jest/globals';
import type { Enrollment, TranslationRequest, TranslationResponse } from '@lang-tutor/core/api';

import { LOOK_UP_IMPORT_ITEM } from '../domain/jobs';
import { PHOTO_READING_MARKER } from '../domain/photoReading';
import { SENSE_MATCH_MARKER } from '../domain/senseMatching';
import { PhotoUnreadable, SenseMatchUnreadable } from '../errors';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { ItemResult, PhotoImportItemRow, PhotoImportRepo, PhotoImportRow } from '../repo/photoImports';
import {
  createFakeClock,
  createFakeJobRepo,
  createFakeLlmClient,
  createFakeLogger,
  createFakeTransaction,
  stub,
} from '../../tests/support/fakes';
import type { VisionJsonRequest } from './llm';
import { createPhotoImportService } from './photoImports';
import type { Repos } from './transaction';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const ID = '11111111-1111-1111-1111-111111111111';
const ENROLLMENT = { id: 'e1', source_language: 'he', target_language: 'it' } as Enrollment;
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

function setup(opts: {
  repos: Partial<Repos>;
  vision?: (request: VisionJsonRequest) => Promise<string>;
  llmReplies?: (string | Error)[];
  lookup?: (input: TranslationRequest) => Promise<TranslationResponse>;
  clock?: number[];
}) {
  const visionCalls: VisionJsonRequest[] = [];
  const lookups: TranslationRequest[] = [];
  const llm = createFakeLlmClient(...(opts.llmReplies ?? ['{"sense":0}']));
  const logger = createFakeLogger();
  const service = createPhotoImportService({
    transaction: createFakeTransaction(opts.repos),
    vision: async (request) => {
      visionCalls.push(request);
      return (opts.vision ?? (async () => '{"items":[]}'))(request);
    },
    llm,
    lookup: async (input) => {
      lookups.push(input);
      if (!opts.lookup) throw new Error('lookup was not expected');
      return opts.lookup(input);
    },
    now: createFakeClock(...(opts.clock ?? [NOW])),
    logger,
  });
  return { service, visionCalls, lookups, llm, logger };
}

const enrollment = stub<EnrollmentRepo>({ findById: async () => ENROLLMENT });
const sense = (n: number, translation: string) => ({ translation, part_of_speech: 'noun', sense_id: `s${n}`, variant_id: `v${n}` });
const response = (over: Partial<TranslationResponse>): TranslationResponse => ({ text: 'gatto', from: 'it', to: 'he', kind: 'word', senses: [], ...over });

describe('readPhoto', () => {
  it('reads the photo, writes its rows, clears it, and enqueues one lookup per row', async () => {
    const jobs = createFakeJobRepo();
    const transitions: unknown[] = [];
    const inserted: unknown[] = [];
    const photoImport = stub<PhotoImportRepo>({
      findImport: async () => importRow({ status: 'reading', photo: 'QUJD' }),
      transition: async (...args) => {
        transitions.push(args);
        return true;
      },
      insertItems: async (...args) => {
        inserted.push(args);
      },
    });
    const { service, visionCalls, logger } = setup({
      repos: { photoImport, enrollment, jobs },
      vision: async () => JSON.stringify({ items: [{ text: 'il gatto', hebrew: 'חתול' }, { text: 'casa', hebrew: '' }, { text: 'casa', hebrew: '' }] }),
      clock: [NOW, NOW + 4_200],
    });

    await service.readPhoto({ import_id: ID });

    expect(visionCalls).toHaveLength(1);
    expect(visionCalls[0].system).toContain(PHOTO_READING_MARKER);
    expect(visionCalls[0].image).toEqual({ data: 'QUJD', mimeType: 'image/jpeg' });
    expect(transitions).toEqual([[ID, ['reading'], 'read']]);
    expect(inserted).toEqual([[ID, [{ position: 0, text: 'il gatto', hebrew: 'חתול' }, { position: 1, text: 'casa', hebrew: null }]]]);
    expect(jobs.enqueued).toEqual([
      { name: LOOK_UP_IMPORT_ITEM, data: { import_id: ID, position: 0 } },
      { name: LOOK_UP_IMPORT_ITEM, data: { import_id: ID, position: 1 } },
    ]);
    expect(logger.events).toContainEqual({
      event: 'photo_read', import_id: ID, item_count: 2, hebrew_count: 1, merged_count: 1, dropped_count: 0, read_ms: 4_200,
    });
    expect(JSON.stringify(logger.events)).not.toContain('חתול');
  });

  it('does not read an import that is no longer reading', async () => {
    const photoImport = stub<PhotoImportRepo>({ findImport: async () => importRow({ status: 'discarded' }) });
    const { service, visionCalls } = setup({ repos: { photoImport, enrollment } });
    await service.readPhoto({ import_id: ID });
    expect(visionCalls).toEqual([]);
  });

  it('throws on an unreadable answer, so pg-boss retries, and writes nothing', async () => {
    const photoImport = stub<PhotoImportRepo>({ findImport: async () => importRow({ status: 'reading', photo: 'QUJD' }) });
    const { service, logger } = setup({ repos: { photoImport, enrollment }, vision: async () => 'not json' });
    await expect(service.readPhoto({ import_id: ID })).rejects.toBeInstanceOf(PhotoUnreadable);
    expect(logger.events.map((event) => event.event)).toContain('photo_read_attempt_failed');
  });

  it('reads an empty answer as a photo with no words', async () => {
    const inserted: unknown[] = [];
    const photoImport = stub<PhotoImportRepo>({
      findImport: async () => importRow({ status: 'reading', photo: 'QUJD' }),
      transition: async () => true,
      insertItems: async (...args) => {
        inserted.push(args);
      },
    });
    const { service } = setup({ repos: { photoImport, enrollment, jobs: createFakeJobRepo() }, vision: async () => '' });
    await service.readPhoto({ import_id: ID });
    expect(inserted).toEqual([[ID, []]]);
  });
});

describe('failRead', () => {
  it('marks a still-reading import failed, which clears its photo', async () => {
    const transitions: unknown[] = [];
    const photoImport = stub<PhotoImportRepo>({
      transition: async (...args) => {
        transitions.push(args);
        return true;
      },
    });
    await setup({ repos: { photoImport } }).service.failRead({ import_id: ID });
    expect(transitions).toEqual([[ID, ['reading'], 'failed']]);
  });
});

describe('lookUpItem', () => {
  const repoFor = (item: PhotoImportItemRow, row: PhotoImportRow = importRow()) => {
    const written: ItemResult[] = [];
    const photoImport = stub<PhotoImportRepo>({
      findImport: async () => row,
      findItem: async () => item,
      writeItem: async (_id, _position, result) => {
        written.push(result);
        return true;
      },
    });
    return { photoImport, written };
  };
  const pending = (over: Partial<PhotoImportItemRow> = {}) =>
    itemRow({ status: 'pending', options: [], chosenSenseId: null, suggestedSenseId: null, ticked: false, ...over });

  it('looks the word up as typed, and starts a row with no Hebrew on its first sense, ticked', async () => {
    const { photoImport, written } = repoFor(pending({ text: 'casa' }));
    const { service, lookups, llm } = setup({
      repos: { photoImport, enrollment },
      lookup: async () => response({ text: 'casa', senses: [sense(1, 'בית'), sense(2, 'משפחה')] }),
    });
    await service.lookUpItem({ import_id: ID, position: 0 });
    expect(lookups).toEqual([{ text: 'casa', from: 'it', to: 'he', enrollment_id: 'e1' }]);
    expect(llm.calls).toEqual([]);
    expect(written).toEqual([
      {
        correctedForm: null,
        options: [
          { sense_id: 's1', variant_id: 'v1', translation: 'בית', part_of_speech: 'noun' },
          { sense_id: 's2', variant_id: 'v2', translation: 'משפחה', part_of_speech: 'noun' },
        ],
        chosenSenseId: 's1',
        ticked: true,
        hebrewMismatch: false,
        reason: null,
      },
    ]);
  });

  it('takes the sense whose translation the printed Hebrew names, with no model call', async () => {
    const { photoImport, written } = repoFor(pending({ text: 'bank', hebrew: 'גדה' }));
    const { service, llm } = setup({ repos: { photoImport, enrollment }, lookup: async () => response({ senses: [sense(1, 'בנק'), sense(2, 'גדה')] }) });
    await service.lookUpItem({ import_id: ID, position: 0 });
    expect(llm.calls).toEqual([]);
    expect(written[0]).toMatchObject({ chosenSenseId: 's2', hebrewMismatch: false });
  });

  it('asks the model when no gloss matches, and takes its sense', async () => {
    const { photoImport, written } = repoFor(pending({ text: 'bank', hebrew: 'גדת נהר' }));
    const { service, llm } = setup({
      repos: { photoImport, enrollment },
      llmReplies: ['{"sense":2}'],
      lookup: async () => response({ senses: [sense(1, 'בנק'), sense(2, 'גדה')] }),
    });
    await service.lookUpItem({ import_id: ID, position: 0 });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].system).toContain(SENSE_MATCH_MARKER);
    expect(written[0]).toMatchObject({ chosenSenseId: 's2', hebrewMismatch: false, ticked: true });
  });

  it('falls back to the first sense, flagged, when the model says none matches', async () => {
    const { photoImport, written } = repoFor(pending({ text: 'banca', hebrew: 'ספסל' }));
    const { service } = setup({ repos: { photoImport, enrollment }, llmReplies: ['{"sense":0}'], lookup: async () => response({ senses: [sense(1, 'בנק')] }) });
    await service.lookUpItem({ import_id: ID, position: 0 });
    expect(written[0]).toMatchObject({ chosenSenseId: 's1', hebrewMismatch: true, ticked: true });
  });

  it('keeps the lookup’s correction, and asks the model about the corrected word', async () => {
    const { photoImport, written } = repoFor(pending({ text: 'gatlo', hebrew: 'חתולה' }));
    const { service, llm } = setup({
      repos: { photoImport, enrollment },
      llmReplies: ['{"sense":1}'],
      lookup: async () => response({ text: 'gatlo', senses: [sense(1, 'חתול')], correction: { corrected_form: 'gatto', alternatives: [] } }),
    });
    await service.lookUpItem({ import_id: ID, position: 0 });
    expect(JSON.parse(llm.calls[0].user).word).toBe('gatto');
    expect(written[0]).toMatchObject({ correctedForm: 'gatto', chosenSenseId: 's1' });
  });

  it('writes a row with no options unticked, with the reason', async () => {
    const { photoImport, written } = repoFor(pending({ text: 'la casa è grande' }));
    const { service } = setup({ repos: { photoImport, enrollment }, lookup: async () => response({ kind: 'sentence', senses: [{ translation: 'הבית גדול' }] }) });
    await service.lookUpItem({ import_id: ID, position: 0 });
    expect(written).toEqual([{ correctedForm: null, options: [], chosenSenseId: null, ticked: false, hebrewMismatch: false, reason: 'sentence' }]);
  });

  it('spends no lookup on a discarded import or a row already settled (Review Focus 1)', async () => {
    for (const [row, item] of [
      [importRow({ status: 'discarded' }), pending()],
      [importRow(), itemRow()],
    ] as const) {
      const { photoImport, written } = repoFor(item, row);
      const { service, lookups } = setup({ repos: { photoImport, enrollment } });
      await service.lookUpItem({ import_id: ID, position: 0 });
      expect(lookups).toEqual([]);
      expect(written).toEqual([]);
    }
  });

  it('throws on an unreadable match, so pg-boss retries', async () => {
    const { photoImport } = repoFor(pending({ text: 'bank', hebrew: 'גדת נהר' }));
    const { service } = setup({ repos: { photoImport, enrollment }, llmReplies: ['nonsense'], lookup: async () => response({ senses: [sense(1, 'בנק')] }) });
    await expect(service.lookUpItem({ import_id: ID, position: 0 })).rejects.toBeInstanceOf(SenseMatchUnreadable);
  });

  it('logs how the sense was chosen, without any Hebrew', async () => {
    const { photoImport } = repoFor(pending({ text: 'bank', hebrew: 'גדה' }));
    const { service, logger } = setup({ repos: { photoImport, enrollment }, lookup: async () => response({ senses: [sense(1, 'בנק'), sense(2, 'גדה')] }) });
    await service.lookUpItem({ import_id: ID, position: 0 });
    expect(logger.events).toContainEqual({
      event: 'import_item_looked_up', import_id: ID, position: 0, matched_by: 'exact', corrected: false, option_count: 2, reason: null,
    });
    expect(JSON.stringify(logger.events)).not.toContain('גדה');
  });
});

describe('failItem', () => {
  it('marks a still-pending row failed', async () => {
    const marked: unknown[] = [];
    const photoImport = stub<PhotoImportRepo>({
      markItemFailed: async (...args) => {
        marked.push(args);
        return true;
      },
    });
    await setup({ repos: { photoImport } }).service.failItem({ import_id: ID, position: 3 });
    expect(marked).toEqual([[ID, 3]]);
  });
});
