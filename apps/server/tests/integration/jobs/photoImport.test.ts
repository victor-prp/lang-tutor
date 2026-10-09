import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PgBoss } from 'pg-boss';

import type { AppDeps } from '../../../src/composition';
import { registerWorkers } from '../../../src/worker';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { startTestBoss, stopTestBoss, waitFor } from '../../support/jobs';
import {
  assertMockServerReachable,
  clearNamespace,
  expectPhotoRead,
  expectPhotoReadFailure,
  expectSenseMatch,
  geminiBaseUrlFor,
  mockNamespace,
} from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { seedEnrollment, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
let boss: PgBoss;
let logger: FakeLogger;
let deps: AppDeps;
let ns: string;
const IT = 'e_it';

beforeEach(async () => {
  await assertMockServerReachable();
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  await seedEnrollment(t.db, { id: IT, userId: 'u_1', targetLanguage: 'it' });
  ns = mockNamespace(expect.getState().currentTestName ?? 'photo-import');
  logger = createFakeLogger();
  boss = await startTestBoss(t.db);
  deps = createTestServerDeps({ db: t.db, logger, rng: testRng(7), boss, geminiBaseUrl: geminiBaseUrlFor(ns) });
  await registerWorkers(boss, deps, { pollingIntervalSeconds: 0.5 });
});

afterEach(async () => {
  await stopTestBoss(boss);
  await clearNamespace(ns);
  await t.close();
});

async function italian(lemma: string, translations: string[]) {
  return insertLexeme(t.db, {
    lemma,
    languageCode: 'it',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: translations.map((_, index) => ({ senseCode: `s${index}` })),
    variants: [
      {
        form: lemma,
        kind: 'word',
        entryRank: 0,
        translations: translations.map((translation, index) => ({
          senseCode: `s${index}`,
          rank: index,
          translation,
          exampleSource: null,
          exampleTarget: null,
        })),
      },
    ],
  });
}

const statusOf = async (id: string) => (await deps.photoImports.getImport('u_1', id)).status;

describe('a photo import through the queue', () => {
  it('reads three rows, chooses each sense, and saves what the review kept', async () => {
    const gatto = await italian('gatto', ['חתול']);
    const banca = await italian('banca', ['בנק']);
    const casa = await italian('casa', ['בית', 'משפחה']);
    await expectPhotoRead(ns, [
      { text: 'gatto', hebrew: 'חתול' },
      { text: 'banca', hebrew: 'ספסל' },
      { text: 'casa', hebrew: '' },
    ]);
    await expectSenseMatch(ns, 0);

    const { id } = await deps.photoImports.create('u_1', IT, { mime_type: 'image/jpeg', image: 'QUJD' });
    await waitFor(async () => (await statusOf(id)) === 'ready');

    const { items } = await deps.photoImports.getImport('u_1', id);
    expect(items.map((item) => [item.text, item.chosen_gloss_id, item.ticked, item.hebrew_mismatch])).toEqual([
      ['gatto', gatto.glossIds[0], true, false],
      ['banca', banca.glossIds[0], true, true],
      ['casa', casa.glossIds[0], true, false],
    ]);
    expect(logger.events.map((event) => event.event)).toEqual(expect.arrayContaining(['photo_read', 'import_item_looked_up']));

    await deps.photoImports.updateItem('u_1', id, 2, { gloss_id: casa.glossIds[1] });
    await deps.photoImports.updateItem('u_1', id, 1, { ticked: false });
    expect(await deps.photoImports.save('u_1', id)).toEqual({ saved_gloss_ids: [gatto.glossIds[0], casa.glossIds[1]] });
    const page = await deps.vocabulary.listWords('u_1', IT, {});
    expect(page.items.map((item) => item.lemma).sort()).toEqual(['casa', 'gatto']);
  });

  it('marks the import failed, with no photo kept, when every read fails', async () => {
    await expectPhotoReadFailure(ns, 500);
    const { id } = await deps.photoImports.create('u_1', IT, { mime_type: 'image/jpeg', image: 'QUJD' });
    await waitFor(async () => (await statusOf(id)) === 'failed', 60_000);
    expect(logger.events.map((event) => event.event)).toContain('photo_read_failed');
  }, 90_000);

  it('marks only the row whose lookup keeps failing, and leaves its siblings ready', async () => {
    await italian('gatto', ['חתול']);
    // `zzzq` is in no dictionary, so its lookup calls the model, and nothing
    // in this namespace answers a lookup.
    await expectPhotoRead(ns, [{ text: 'gatto', hebrew: '' }, { text: 'zzzq', hebrew: '' }]);
    const { id } = await deps.photoImports.create('u_1', IT, { mime_type: 'image/jpeg', image: 'QUJD' });
    await waitFor(async () => (await statusOf(id)) === 'ready', 60_000);
    const { items } = await deps.photoImports.getImport('u_1', id);
    expect(items.map((item) => item.status)).toEqual(['ready', 'failed']);
  }, 90_000);
});
