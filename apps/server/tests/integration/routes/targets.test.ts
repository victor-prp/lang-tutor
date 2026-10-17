import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PhotoImportOption, Target, TargetList, VocabularyEntryInput } from '@lang-tutor/core/api';
import { Hono } from 'hono';
import type { PgBoss } from 'pg-boss';

import type { AppDeps } from '../../../src/composition';
import { createTargetsRouter } from '../../../src/routes/targets';
import { ACT_AS, actAs } from '../../support/actAs';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger } from '../../support/fakes';
import { startTestBoss, stopTestBoss } from '../../support/jobs';
import { seedPhotoImport } from '../../support/photoImportRows';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, makeBot, seedUser } from '../../support/seedUser';
import { readTargetEvents, seedTarget } from '../../support/targetRows';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { readSavedGlossIds } from '../../support/vocabularyRows';

// Phase 53 (spec D1, D2, D10, D11, D13). The target routes over the real service and database:
// each route's success, what it refuses and how it says so, a stranger's 403, and a closed
// target's 409. The learner is a bot, so the day is the profile's and the clock decides nothing
// (ADR 0013). What the service does with a request is tests/integration/services/targets.test.ts's.

const E = enrollmentOf('u_1');
const DAY = '2030-01-08';
const DUE = '2030-01-13';
const NO_SUCH_UUID = '00000000-0000-0000-0000-000000000000';

let t: TestDb;
let boss: PgBoss;
let deps: AppDeps;

beforeEach(async () => {
  t = await createTestDb();
  boss = await startTestBoss(t.db);
  await seedUser(t.db, 'u_1');
  await makeBot(t.db, 'u_1', DAY);
  await seedUser(t.db, 'u_2');
  deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7), boss });
});
afterEach(async () => {
  await stopTestBoss(boss);
  await t.close();
});

function app() {
  const hono = new Hono();
  hono.use('*', actAs());
  hono.route('/api', createTargetsRouter(deps.targets));
  return hono;
}

/** A response as `{ status, body }`. A body that is not JSON (a 500's) stays text, so a failure names it. */
async function answer(res: Response): Promise<{ status: number; body: unknown }> {
  const text = await res.text();
  try {
    return { status: res.status, body: text === '' ? '' : JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}
// Acts as the list's owner unless a case says otherwise.
const call = async (method: string, path: string, body?: unknown, actor = 'u_1') =>
  answer(
    await app().request('/api' + path, {
      method,
      headers: { [ACT_AS]: actor, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

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

const createUrl = '/enrollments/' + E + '/targets';
const createBody = (kind: string, due_on: string, ...options: PhotoImportOption[]) => ({
  kind,
  due_on,
  photo_import_ids: [] as string[],
  entries: options.map(typed),
});

/** A target of u_1's made through the route from typed words alone. */
async function made(kind: 'homework' | 'exam', dueOn: string, ...options: PhotoImportOption[]): Promise<Target> {
  const created = await call('POST', createUrl, createBody(kind, dueOn, ...options));
  expect(created.status).toBe(201);
  return created.body as Target;
}
const read = async (id: string) => (await call('GET', '/targets/' + id)).body as Target;
const listed = async () => (await call('GET', createUrl)).body as TargetList;
const eventKinds = async (id: string) => (await readTargetEvents(t.db, id)).map((event) => event.kind);

describe('POST /api/enrollments/{id}/targets', () => {
  it('answers 201 with the target: its kind, date, days left and words, in the order they were brought', async () => {
    const [apple, bread, cheese] = [await word('apple', 'תפוח'), await word('bread', 'לחם'), await word('cheese', 'גבינה')];
    const photo = await photoOf(apple, bread);

    const res = await call('POST', createUrl, { kind: 'exam', due_on: DUE, photo_import_ids: [photo], entries: [typed(cheese)] });

    expect(res).toEqual({
      status: 201,
      body: {
        id: expect.any(String),
        kind: 'exam',
        due_on: DUE,
        days_left: 5,
        word_count: 3,
        ready_count: 0,
        readiness_pct: 0,
        today: expect.objectContaining({ state: 'owed' }),
        session: null,
        words: [
          expect.objectContaining({ gloss_id: apple.gloss_id, form: 'apple', meaning: 'תפוח', readiness_pct: 0, today: expect.any(String) }),
          expect.objectContaining({ gloss_id: bread.gloss_id, form: 'bread', meaning: 'לחם', readiness_pct: 0, today: expect.any(String) }),
          expect.objectContaining({ gloss_id: cheese.gloss_id, form: 'cheese', meaning: 'גבינה', readiness_pct: 0, today: expect.any(String) }),
        ],
      },
    });
    // One transaction: the words are saved, the photo is saved, and the log has its first line.
    expect(await readSavedGlossIds(t.db, E)).toEqual([apple.gloss_id, bread.gloss_id, cheese.gloss_id].sort());
    expect((await deps.photoImports.getImport('u_1', photo)).status).toBe('saved');
    const [target] = (await listed()).targets;
    expect(await eventKinds(target.id)).toEqual(['created']);
  });

  it('makes a homework target as well', async () => {
    const apple = await word('apple', 'תפוח');
    expect(await made('homework', DUE, apple)).toMatchObject({ kind: 'homework', due_on: DUE, word_count: 1 });
  });

  it('answers 400 invalid target, reason due_date, for a date that is not after the learner’s today, and saves nothing', async () => {
    const apple = await word('apple', 'תפוח');
    for (const due_on of [DAY, '2030-01-07', '2029-12-31']) {
      expect([due_on, await call('POST', createUrl, createBody('exam', due_on, apple))]).toEqual([
        due_on,
        { status: 400, body: { error: 'invalid target', reason: 'due_date' } },
      ]);
    }
    expect(await readSavedGlossIds(t.db, E)).toEqual([]);
  });

  it('answers 400 invalid target, reason no_words, when no word came out of the photos, and leaves the photo open', async () => {
    const empty = await seedPhotoImport(t.db, { enrollmentId: E, status: 'read', items: [] });
    const res = await call('POST', createUrl, { kind: 'exam', due_on: DUE, photo_import_ids: [empty], entries: [] });
    expect(res).toEqual({ status: 400, body: { error: 'invalid target', reason: 'no_words' } });
    expect((await deps.photoImports.getImport('u_1', empty)).status).not.toBe('saved');
    expect((await listed()).targets).toEqual([]);
  });

  it('answers 400 invalid target, reason unknown_import, for an import that is not there or is another list’s', async () => {
    const apple = await word('apple', 'תפוח');
    const strangers = await seedPhotoImport(t.db, { enrollmentId: enrollmentOf('u_2'), status: 'read', items: [{ text: 'apple', options: [apple] }] });
    for (const id of [NO_SUCH_UUID, 'nope', strangers]) {
      const res = await call('POST', createUrl, { kind: 'exam', due_on: DUE, photo_import_ids: [id], entries: [typed(apple)] });
      expect([id, res]).toEqual([id, { status: 400, body: { error: 'invalid target', reason: 'unknown_import' } }]);
    }
    expect(await readSavedGlossIds(t.db, E)).toEqual([]);
    expect((await deps.photoImports.getImport('u_2', strangers)).status).toBe('ready');
  });

  it('answers 400 invalid vocabulary entry for a typed word this list cannot save, and saves nothing', async () => {
    const apple = await word('apple', 'תפוח');
    const res = await call('POST', createUrl, {
      kind: 'exam',
      due_on: DUE,
      photo_import_ids: [],
      entries: [typed(apple), { gloss_id: 'no-such-gloss', variant_id: 'no-such-variant' }],
    });
    expect(res).toEqual({ status: 400, body: { error: 'invalid vocabulary entry' } });
    expect(await readSavedGlossIds(t.db, E)).toEqual([]);
  });

  it('answers 409 photo import not ready for a photo still being read, and saves nothing', async () => {
    const apple = await word('apple', 'תפוח');
    const reading = await seedPhotoImport(t.db, { enrollmentId: E, status: 'reading', items: [] });
    const res = await call('POST', createUrl, { kind: 'exam', due_on: DUE, photo_import_ids: [reading], entries: [typed(apple)] });
    expect(res).toEqual({ status: 409, body: { error: 'photo import not ready' } });
    expect(await readSavedGlossIds(t.db, E)).toEqual([]);
  });

  it('answers 404 for an enrollment that does not exist', async () => {
    const apple = await word('apple', 'תפוח');
    const res = await call('POST', '/enrollments/nope/targets', createBody('exam', DUE, apple));
    expect(res).toEqual({ status: 404, body: { error: 'enrollment not found' } });
  });

  it('answers 400 invalid request for a body that does not validate, and for a due date that is not on the calendar', async () => {
    const apple = await word('apple', 'תפוח');
    const valid = createBody('exam', DUE, apple);
    for (const override of [
      { kind: 'quiz' },
      { due_on: '13/01/2030' },
      // After today and the shape of a day, so it once passed every check and Postgres refused it: a 500.
      { due_on: '2030-02-30' },
      { due_on: '2030-13-01' },
      { due_on: '2031-02-29' },
      { photo_import_ids: undefined },
      { entries: Array(51).fill(typed(apple)) },
    ]) {
      expect([override, await call('POST', createUrl, { ...valid, ...override })]).toEqual([
        override,
        { status: 400, body: { error: 'invalid request' } },
      ]);
    }
    expect(await readSavedGlossIds(t.db, E)).toEqual([]);
    expect((await listed()).targets).toEqual([]);
  });
});

describe('GET /api/enrollments/{id}/targets', () => {
  it('answers the active targets, nearest date first, with the learner’s today and no words', async () => {
    const [apple, bread] = [await word('apple', 'תפוח'), await word('bread', 'לחם')];
    const later = await made('homework', '2030-01-20', apple);
    const sooner = await made('exam', DUE, apple, bread);

    expect(await call('GET', createUrl)).toEqual({
      status: 200,
      body: {
        today: DAY,
        targets: [
          {
            id: sooner.id,
            kind: 'exam',
            due_on: DUE,
            days_left: 5,
            word_count: 2,
            ready_count: 0,
            readiness_pct: 0,
            today: { state: 'owed', done: 0, planned: 1, extra: 0, next_practice_in: 1 },
            session: null,
          },
          {
            id: later.id,
            kind: 'homework',
            due_on: '2030-01-20',
            days_left: 12,
            word_count: 1,
            ready_count: 0,
            readiness_pct: 0,
            today: { state: 'owed', done: 0, planned: 1, extra: 0, next_practice_in: 3 },
            session: null,
          },
        ],
      },
    });
  });

  it('answers 200 with the day and no target for a learner who has none', async () => {
    expect(await call('GET', createUrl)).toEqual({ status: 200, body: { today: DAY, targets: [] } });
  });

  it('leaves out a target that was ended and one whose date has passed, and keeps one due today (phase 57, spec D10)', async () => {
    const [apple, bread] = [await word('apple', 'תפוח'), await word('bread', 'לחם')];
    const kept = await made('exam', DUE, apple);
    const ended = await made('exam', '2030-01-15', apple);
    expect(await call('POST', '/targets/' + ended.id + '/end')).toEqual({ status: 204, body: '' });
    await seedTarget(t.db, { enrollmentId: E, kind: 'homework', dueOn: '2030-01-07', glossIds: [bread.gloss_id] });
    const dueToday = await seedTarget(t.db, { enrollmentId: E, kind: 'homework', dueOn: DAY, glossIds: [bread.gloss_id] });

    expect((await listed()).targets.map((target) => target.id)).toEqual([dueToday, kept.id]);
    // On its date a target is due_today: the day's work is the due-date exam, nothing owed.
    expect((await listed()).targets[0]).toMatchObject({ id: dueToday, days_left: 0, ready_count: 0, today: { state: 'due_today' } });
  });

  it('answers 404 for an enrollment that does not exist', async () => {
    expect(await call('GET', '/enrollments/nope/targets')).toEqual({ status: 404, body: { error: 'enrollment not found' } });
  });
});

describe('GET /api/targets/{id}', () => {
  it('answers the target with its words, as the create answered it', async () => {
    const [apple, bread] = [await word('apple', 'תפוח'), await word('bread', 'לחם')];
    const created = await made('exam', DUE, apple, bread);
    expect(await call('GET', '/targets/' + created.id)).toEqual({ status: 200, body: created });
  });

  it('reads a target that was ended and one whose date has come, which the list leaves out', async () => {
    const apple = await word('apple', 'תפוח');
    const ended = await made('exam', DUE, apple);
    await call('POST', '/targets/' + ended.id + '/end');
    const past = await seedTarget(t.db, { enrollmentId: E, kind: 'homework', dueOn: '2030-01-05', glossIds: [apple.gloss_id] });

    expect(await read(ended.id)).toMatchObject({ id: ended.id, due_on: DUE, word_count: 1 });
    expect(await read(past)).toMatchObject({ id: past, kind: 'homework', due_on: '2030-01-05' });
  });

  it('answers 404 for a target that does not exist and for an id that is not even a uuid', async () => {
    for (const id of [NO_SUCH_UUID, 'nope']) {
      expect([id, await call('GET', '/targets/' + id)]).toEqual([id, { status: 404, body: { error: 'target not found' } }]);
    }
  });
});

describe('PATCH /api/targets/{id}', () => {
  it('moves the date, earlier or later, and answers the target as it now is', async () => {
    const apple = await word('apple', 'תפוח');
    const created = await made('exam', DUE, apple);

    // The date moves the whole day (cap, plan), so only what names the target is compared.
    expect(await call('PATCH', '/targets/' + created.id, { due_on: '2030-01-20' })).toMatchObject({
      status: 200,
      body: { id: created.id, kind: 'exam', due_on: '2030-01-20', days_left: 12, word_count: 1 },
    });
    // The date moves the whole day (cap, plan), so only what names the target is compared.
    expect(await call('PATCH', '/targets/' + created.id, { due_on: '2030-01-10' })).toMatchObject({
      status: 200,
      body: { id: created.id, kind: 'exam', due_on: '2030-01-10', days_left: 2, word_count: 1 },
    });
    expect(await read(created.id)).toMatchObject({ due_on: '2030-01-10' });
    expect(await eventKinds(created.id)).toEqual(['created', 'date_changed', 'date_changed']);
  });

  it('answers 200 and records nothing for the date the target has', async () => {
    const apple = await word('apple', 'תפוח');
    const created = await made('exam', DUE, apple);
    expect(await call('PATCH', '/targets/' + created.id, { due_on: DUE })).toEqual({ status: 200, body: created });
    expect(await eventKinds(created.id)).toEqual(['created']);
  });

  it('answers 400 invalid target, reason due_date, for today and for a day before it', async () => {
    const apple = await word('apple', 'תפוח');
    const created = await made('exam', DUE, apple);
    for (const due_on of [DAY, '2030-01-01']) {
      expect([due_on, await call('PATCH', '/targets/' + created.id, { due_on })]).toEqual([
        due_on,
        { status: 400, body: { error: 'invalid target', reason: 'due_date' } },
      ]);
    }
    expect(await read(created.id)).toMatchObject({ due_on: DUE });
  });

  it('answers 400 invalid request for a date that is not on the calendar, not a 500', async () => {
    const apple = await word('apple', 'תפוח');
    const created = await made('exam', DUE, apple);
    for (const body of [{ due_on: '2030-02-30' }, { due_on: '2030-13-01' }, { due_on: '2031-02-29' }, { due_on: '20300201' }, {}]) {
      expect([body, await call('PATCH', '/targets/' + created.id, body)]).toEqual([body, { status: 400, body: { error: 'invalid request' } }]);
    }
    expect(await read(created.id)).toMatchObject({ due_on: DUE });
  });

  it('answers 404 for a target that does not exist', async () => {
    for (const id of [NO_SUCH_UUID, 'nope']) {
      expect([id, await call('PATCH', '/targets/' + id, { due_on: DUE })]).toEqual([id, { status: 404, body: { error: 'target not found' } }]);
    }
  });
});

describe('POST /api/targets/{id}/words', () => {
  it('adds typed words and a photo’s, after the words it has, and answers the target as it now is', async () => {
    const [apple, bread, cheese, dates] = [await word('apple', 'תפוח'), await word('bread', 'לחם'), await word('cheese', 'גבינה'), await word('dates', 'תמרים')];
    const created = await made('exam', DUE, apple);
    const photo = await photoOf(bread, cheese);

    const res = await call('POST', '/targets/' + created.id + '/words', { photo_import_ids: [photo], entries: [typed(dates)] });

    expect(res.status).toBe(200);
    const body = res.body as Target;
    expect(body.words.map((each) => each.form)).toEqual(['apple', 'bread', 'cheese', 'dates']);
    expect(body).toMatchObject({ id: created.id, word_count: 4 });
    expect(await read(created.id)).toEqual(body);
    expect((await deps.photoImports.getImport('u_1', photo)).status).toBe('saved');
    expect(await eventKinds(created.id)).toEqual(['created', 'words_added']);
  });

  it('keeps a word the target holds where it is, and records nothing when there is nothing new', async () => {
    const [apple, bread] = [await word('apple', 'תפוח'), await word('bread', 'לחם')];
    const created = await made('exam', DUE, apple, bread);
    const res = await call('POST', '/targets/' + created.id + '/words', { photo_import_ids: [], entries: [typed(bread), typed(apple)] });
    expect(res).toEqual({ status: 200, body: created });
    expect(await eventKinds(created.id)).toEqual(['created']);
  });

  it('answers 400 invalid request for an add of nothing, and for lists over the bounds', async () => {
    const apple = await word('apple', 'תפוח');
    const created = await made('exam', DUE, apple);
    for (const body of [
      { photo_import_ids: [], entries: [] },
      {},
      { photo_import_ids: Array.from({ length: 11 }, (_, index) => 'i' + index), entries: [] },
      { photo_import_ids: [], entries: Array(51).fill(typed(apple)) },
    ]) {
      expect(await call('POST', '/targets/' + created.id + '/words', body)).toEqual({ status: 400, body: { error: 'invalid request' } });
    }
  });

  it('answers 400 invalid target, reason unknown_import, and 400 invalid vocabulary entry', async () => {
    const apple = await word('apple', 'תפוח');
    const created = await made('exam', DUE, apple);
    expect(await call('POST', '/targets/' + created.id + '/words', { photo_import_ids: [NO_SUCH_UUID], entries: [] })).toEqual({
      status: 400,
      body: { error: 'invalid target', reason: 'unknown_import' },
    });
    const bad = { photo_import_ids: [], entries: [{ gloss_id: 'no-such-gloss', variant_id: 'no-such-variant' }] };
    expect(await call('POST', '/targets/' + created.id + '/words', bad)).toEqual({ status: 400, body: { error: 'invalid vocabulary entry' } });
    expect(await read(created.id)).toEqual(created);
  });

  it('answers 409 photo import not ready for a photo still being read, and adds nothing', async () => {
    const [apple, bread] = [await word('apple', 'תפוח'), await word('bread', 'לחם')];
    const created = await made('exam', DUE, apple);
    const reading = await seedPhotoImport(t.db, { enrollmentId: E, status: 'reading', items: [] });
    const res = await call('POST', '/targets/' + created.id + '/words', { photo_import_ids: [reading], entries: [typed(bread)] });
    expect(res).toEqual({ status: 409, body: { error: 'photo import not ready' } });
    expect(await read(created.id)).toEqual(created);
    expect(await readSavedGlossIds(t.db, E)).toEqual([apple.gloss_id]);
  });

  it('answers 404 for a target that does not exist', async () => {
    const apple = await word('apple', 'תפוח');
    const res = await call('POST', '/targets/' + NO_SUCH_UUID + '/words', { photo_import_ids: [], entries: [typed(apple)] });
    expect(res).toEqual({ status: 404, body: { error: 'target not found' } });
  });
});

describe('DELETE /api/targets/{id}/words/{gloss_id}', () => {
  it('takes the word out of the target and answers 204 with no body; the word stays saved', async () => {
    const [apple, bread] = [await word('apple', 'תפוח'), await word('bread', 'לחם')];
    const created = await made('exam', DUE, apple, bread);

    expect(await call('DELETE', '/targets/' + created.id + '/words/' + apple.gloss_id)).toEqual({ status: 204, body: '' });

    expect((await read(created.id)).words.map((each) => each.form)).toEqual(['bread']);
    expect(await readSavedGlossIds(t.db, E)).toEqual([apple.gloss_id, bread.gloss_id].sort());
    expect(await eventKinds(created.id)).toEqual(['created', 'words_removed']);
  });

  it('is idempotent: a word the target does not hold also answers 204, and records nothing', async () => {
    const [apple, bread] = [await word('apple', 'תפוח'), await word('bread', 'לחם')];
    const created = await made('exam', DUE, apple);
    for (const glossId of [bread.gloss_id, 'no-such-gloss']) {
      expect([glossId, await call('DELETE', '/targets/' + created.id + '/words/' + glossId)]).toEqual([glossId, { status: 204, body: '' }]);
    }
    expect(await read(created.id)).toEqual(created);
    expect(await eventKinds(created.id)).toEqual(['created']);
  });

  it('may take out the last word: the target stays, empty', async () => {
    const apple = await word('apple', 'תפוח');
    const created = await made('exam', DUE, apple);
    expect(await call('DELETE', '/targets/' + created.id + '/words/' + apple.gloss_id)).toEqual({ status: 204, body: '' });
    expect(await read(created.id)).toMatchObject({ id: created.id, word_count: 0, words: [] });
    expect((await listed()).targets.map((target) => target.id)).toEqual([created.id]);
  });

  it('answers 404 for a target that does not exist', async () => {
    expect(await call('DELETE', '/targets/' + NO_SUCH_UUID + '/words/g1')).toEqual({ status: 404, body: { error: 'target not found' } });
  });
});

describe('POST /api/targets/{id}/end', () => {
  it('ends the target and answers 204 with no body; the list drops it, its screen still reads, its words stay saved', async () => {
    const apple = await word('apple', 'תפוח');
    const created = await made('exam', DUE, apple);

    expect(await call('POST', '/targets/' + created.id + '/end')).toEqual({ status: 204, body: '' });

    expect((await listed()).targets).toEqual([]);
    expect(await read(created.id)).toEqual(created);
    expect(await readSavedGlossIds(t.db, E)).toEqual([apple.gloss_id]);
    expect(await eventKinds(created.id)).toEqual(['created', 'ended_early']);
  });

  it('is idempotent: ending an ended target answers 204 again and records nothing more', async () => {
    const apple = await word('apple', 'תפוח');
    const created = await made('exam', DUE, apple);
    expect(await call('POST', '/targets/' + created.id + '/end')).toEqual({ status: 204, body: '' });
    expect(await call('POST', '/targets/' + created.id + '/end')).toEqual({ status: 204, body: '' });
    expect(await eventKinds(created.id)).toEqual(['created', 'ended_early']);
  });

  it('answers 404 for a target that does not exist', async () => {
    for (const id of [NO_SUCH_UUID, 'nope']) {
      expect([id, await call('POST', '/targets/' + id + '/end')]).toEqual([id, { status: 404, body: { error: 'target not found' } }]);
    }
  });
});

// A target is open to change while its date is still to come and it was not ended early.
describe('a closed target', () => {
  /** An ended target, and one whose date has come: the two ways a target closes. */
  async function closedTargets() {
    const apple = await word('apple', 'תפוח');
    const bread = await word('bread', 'לחם');
    const ended = await made('exam', DUE, apple);
    await call('POST', '/targets/' + ended.id + '/end');
    const expired = await seedTarget(t.db, { enrollmentId: E, kind: 'homework', dueOn: DAY, glossIds: [apple.gloss_id] });
    return { apple, bread, targets: { ended: ended.id, expired } };
  }

  it('answers 409 target closed to a new date, to words and to the removal of a word, and changes nothing', async () => {
    const { apple, bread, targets } = await closedTargets();
    for (const [which, id] of Object.entries(targets)) {
      for (const [method, path, body] of [
        ['PATCH', '/targets/' + id, { due_on: '2030-02-01' }],
        ['POST', '/targets/' + id + '/words', { photo_import_ids: [], entries: [typed(bread)] }],
        ['DELETE', '/targets/' + id + '/words/' + apple.gloss_id, undefined],
      ] as const) {
        expect([which, method, path, await call(method, path, body)]).toEqual([which, method, path, { status: 409, body: { error: 'target closed' } }]);
      }
    }
    expect(await readSavedGlossIds(t.db, E)).toEqual([apple.gloss_id]);
    expect(await read(targets.ended)).toMatchObject({ due_on: DUE, word_count: 1 });
    expect(await read(targets.expired)).toMatchObject({ due_on: DAY });
  });

  it('answers 409 target closed to the end of a target whose date has come, where an ended one answers 204', async () => {
    const { targets } = await closedTargets();
    expect(await call('POST', '/targets/' + targets.expired + '/end')).toEqual({ status: 409, body: { error: 'target closed' } });
    expect(await call('POST', '/targets/' + targets.ended + '/end')).toEqual({ status: 204, body: '' });
  });
});

// Spec D2: a target is its list owner's alone.
describe('another learner', () => {
  it('is answered 403 on every target route, and nothing changes', async () => {
    const [apple, bread] = [await word('apple', 'תפוח'), await word('bread', 'לחם')];
    const created = await made('exam', DUE, apple);
    const before = { target: await read(created.id), list: await listed(), saved: await readSavedGlossIds(t.db, E), events: await readTargetEvents(t.db, created.id) };

    for (const [method, path, body] of [
      ['GET', createUrl, undefined],
      ['POST', createUrl, createBody('homework', DUE, bread)],
      ['GET', '/targets/' + created.id, undefined],
      ['PATCH', '/targets/' + created.id, { due_on: '2030-01-20' }],
      ['POST', '/targets/' + created.id + '/end', undefined],
      ['POST', '/targets/' + created.id + '/words', { photo_import_ids: [], entries: [typed(bread)] }],
      ['DELETE', '/targets/' + created.id + '/words/' + apple.gloss_id, undefined],
    ] as const) {
      expect([method, path, await call(method, path, body, 'u_2')]).toEqual([method, path, { status: 403, body: { error: 'forbidden' } }]);
    }

    expect(await read(created.id)).toEqual(before.target);
    expect(await listed()).toEqual(before.list);
    expect(await readSavedGlossIds(t.db, E)).toEqual(before.saved);
    expect(await readTargetEvents(t.db, created.id)).toEqual(before.events);
  });

  it('reads their own list, with none of the owner’s targets in it', async () => {
    const apple = await word('apple', 'תפוח');
    await made('exam', DUE, apple);
    const own = await call('GET', '/enrollments/' + enrollmentOf('u_2') + '/targets', undefined, 'u_2');
    expect(own).toEqual({ status: 200, body: { today: expect.any(String), targets: [] } });
  });
});
