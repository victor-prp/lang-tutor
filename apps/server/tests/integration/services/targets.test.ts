import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PhotoImportOption, VocabularyEntryInput } from '@lang-tutor/core/api';
import type { PgBoss } from 'pg-boss';

import type { AppDeps } from '../../../src/composition';
import { STOCK_SESSION } from '../../../src/domain/jobs';
import { InvalidTarget } from '../../../src/errors';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { jobPayloads, startTestBoss, stopTestBoss } from '../../support/jobs';
import { seedPhotoImport } from '../../support/photoImportRows';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, makeBot, seedUser } from '../../support/seedUser';
import { readStockRow, readTargetEvents } from '../../support/targetRows';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { readSavedGlossIds, seedSavedSenses } from '../../support/vocabularyRows';

// Phase 53 (spec D1, D8, D10, D12; rulings R-D9, R-D12b). The targets service over the real
// repositories: a target made from photo imports and typed words in one transaction, a word
// unsaved out of it, and the learner's day (a bot's here, ADR 0013) deciding the dates. The
// learner is a bot, so the day is the profile's and moves only when a test moves it.

const E = enrollmentOf('u_1');
const DAY = '2030-01-08';
const DUE = '2030-01-13';
const NO_DEVICES = { listening: false, speaking: false };

let t: TestDb;
let boss: PgBoss;
let logger: FakeLogger;
let deps: AppDeps;

beforeEach(async () => {
  t = await createTestDb();
  boss = await startTestBoss(t.db);
  await seedUser(t.db, 'u_1');
  await makeBot(t.db, 'u_1', DAY);
  logger = createFakeLogger();
  deps = createTestServerDeps({ db: t.db, logger, rng: testRng(7), boss });
});
afterEach(async () => {
  await stopTestBoss(boss);
  await t.close();
});

/** The word each option was made for: the text of a photo's row. */
const lemmaOf = new Map<string, string>();

/** An English word with one sense, rendered in Hebrew, not saved: a photo row's option. */
async function word(lemma: string, hebrew: string): Promise<PhotoImportOption> {
  const ids = await insertLexeme(t.db, {
    lemma,
    languageCode: 'en',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'a' }],
    variants: [
      {
        form: lemma,
        kind: 'word',
        entryRank: 0,
        translations: [{ senseCode: 'a', rank: 0, translation: hebrew, exampleSource: null, exampleTarget: null }],
      },
    ],
  });
  lemmaOf.set(ids.glossIds[0], lemma);
  return { gloss_id: ids.glossIds[0], variant_id: ids.variantIds[0], translation: hebrew };
}
const typed = (option: PhotoImportOption): VocabularyEntryInput => ({ gloss_id: option.gloss_id, variant_id: option.variant_id });
/** A photo read and looked up, every row ticked on its one option. */
const photoOf = (...options: PhotoImportOption[]) =>
  seedPhotoImport(t.db, {
    enrollmentId: E,
    status: 'read',
    items: options.map((option) => ({ text: lemmaOf.get(option.gloss_id)!, options: [option] })),
  });

describe('create (spec D10, ruling R-D9)', () => {
  it('saves two photos sharing a word and a typed word, and makes one target of them, in one transaction', async () => {
    const [apple, bread, cheese, dates] = [await word('apple', 'תפוח'), await word('bread', 'לחם'), await word('cheese', 'גבינה'), await word('dates', 'תמרים')];
    const first = await photoOf(apple, bread);
    const second = await photoOf(bread, cheese);

    const made = await deps.targets.create('u_1', E, { kind: 'exam', due_on: DUE, photo_import_ids: [first, second], entries: [typed(dates)] });

    const union = [apple.gloss_id, bread.gloss_id, cheese.gloss_id, dates.gloss_id];
    expect(made).toMatchObject({ kind: 'exam', due_on: DUE, days_left: 5, word_count: 4, ready_count: 0 });
    expect(made.words).toEqual([
      { gloss_id: apple.gloss_id, form: 'apple', meaning: 'תפוח', readiness: 'not_started' },
      { gloss_id: bread.gloss_id, form: 'bread', meaning: 'לחם', readiness: 'not_started' },
      { gloss_id: cheese.gloss_id, form: 'cheese', meaning: 'גבינה', readiness: 'not_started' },
      { gloss_id: dates.gloss_id, form: 'dates', meaning: 'תמרים', readiness: 'not_started' },
    ]);
    expect(await readSavedGlossIds(t.db, E)).toEqual([...union].sort());
    expect((await deps.photoImports.getImport('u_1', first)).status).toBe('saved');
    expect((await deps.photoImports.getImport('u_1', second)).status).toBe('saved');
    expect(await readTargetEvents(t.db, made.id)).toEqual([
      { kind: 'created', before: null, after: { kind: 'exam', due_on: DUE, gloss_ids: union }, actorUserId: 'u_1', sessionId: null },
    ]);
    expect(await deps.targets.get('u_1', made.id)).toEqual(made);
    expect((await deps.targets.list('u_1', E)).targets.map((listed) => listed.id)).toEqual([made.id]);
    expect(logger.events).toContainEqual({ event: 'target_created', enrollment_id: E, target_id: made.id, kind: 'exam', word_count: 4 });
  });

  it('decides the date by the bot’s day, not the clock: its today is refused, and the day after is one day left (ADR 0013)', async () => {
    const apple = await word('apple', 'תפוח');
    const request = { kind: 'homework' as const, photo_import_ids: [], entries: [typed(apple)] };

    const refusal = deps.targets.create('u_1', E, { ...request, due_on: DAY });
    await expect(refusal).rejects.toBeInstanceOf(InvalidTarget);
    await expect(refusal).rejects.toMatchObject({ reason: 'due_date' });
    expect(await readSavedGlossIds(t.db, E)).toEqual([]);

    expect(await deps.targets.create('u_1', E, { ...request, due_on: '2030-01-09' })).toMatchObject({ due_on: '2030-01-09', days_left: 1 });
  });
});

describe('unsave (spec D1)', () => {
  it('takes the word out of the target, with words_removed in its log, and keeps the others', async () => {
    const [apple, bread] = [await word('apple', 'תפוח'), await word('bread', 'לחם')];
    const made = await deps.targets.create('u_1', E, { kind: 'exam', due_on: DUE, photo_import_ids: [], entries: [typed(apple), typed(bread)] });

    await deps.vocabulary.unsave('u_1', E, apple.gloss_id);

    expect((await deps.targets.get('u_1', made.id)).words.map((kept) => kept.gloss_id)).toEqual([bread.gloss_id]);
    expect((await readTargetEvents(t.db, made.id)).map(({ kind, before, after, actorUserId }) => ({ kind, before, after, actorUserId }))).toEqual([
      { kind: 'created', before: null, after: { kind: 'exam', due_on: DUE, gloss_ids: [apple.gloss_id, bread.gloss_id] }, actorUserId: 'u_1' },
      { kind: 'words_removed', before: { gloss_ids: [apple.gloss_id] }, after: { reason: 'unsaved' }, actorUserId: 'u_1' },
    ]);
  });
});

describe('the stock a change leaves (ruling R-D12b)', () => {
  it('retires the unstarted list stock and asks the stock job for the next', async () => {
    const seed = await deps.sessions.createNextSession('u_1', E, NO_DEVICES);
    await deps.sessions.skipSession('u_1', seed.sessionId);
    const words: VocabularyEntryInput[] = [];
    for (const [lemma, hebrew] of [['apple', 'תפוח'], ['bread', 'לחם'], ['cheese', 'גבינה']]) {
      const saved = await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [hebrew] });
      words.push({ gloss_id: saved.glossIds[0], variant_id: saved.variantId });
    }
    const { sessionId: stock, status } = await deps.sessions.createNextSession('u_1', E, NO_DEVICES);
    expect(status).toBe('preparing');

    await deps.targets.create('u_1', E, { kind: 'exam', due_on: DUE, photo_import_ids: [], entries: words.slice(0, 2) });

    expect(await readStockRow(t.db, stock)).toEqual({ status: 'skipped', practiceDay: null, chosenOn: DAY });
    expect(await jobPayloads(t.db, STOCK_SESSION)).toContainEqual({ enrollment_id: E, reason: 'target' });
    expect(logger.events).toContainEqual({ event: 'session_retired', enrollment_id: E, session_id: stock, reason: 'target_changed' });
  });
});
