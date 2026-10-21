import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { DiscoveryAnswerResult, DiscoveryRun, DiscoveryState } from '@lang-tutor/core/api';
import { Hono } from 'hono';
import type { PgBoss } from 'pg-boss';

import type { AppDeps } from '../../../src/composition';
import { createDiscoveryRouter } from '../../../src/routes/discovery';
import { registerWorkers } from '../../../src/worker';
import { ACT_AS, actAs } from '../../support/actAs';
import { insertLexeme } from '../../support/dictRows';
import { seedDiscoveryProfile, seedDiscoveryRun } from '../../support/discoveryRows';
import { createFakeLogger } from '../../support/fakes';
import { startTestBoss, stopTestBoss, waitFor } from '../../support/jobs';
import {
  assertMockServerReachable,
  clearNamespace,
  countGeminiRequests,
  expectDiscovery,
  expectJudge,
  geminiBaseUrlFor,
  mockNamespace,
} from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { seedEnrollment, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { readSavedGlossIds } from '../../support/vocabularyRows';

let t: TestDb;
let boss: PgBoss;
let deps: AppDeps;
let ns: string;
const IT = 'e_it';

beforeEach(async () => {
  await assertMockServerReachable();
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  await seedUser(t.db, 'u_2');
  await seedEnrollment(t.db, { id: IT, userId: 'u_1', targetLanguage: 'it' });
  ns = mockNamespace(expect.getState().currentTestName ?? 'discovery');
  boss = await startTestBoss(t.db);
  deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7), boss, geminiBaseUrl: geminiBaseUrlFor(ns) });
  await registerWorkers(boss, deps, { pollingIntervalSeconds: 0.5 });
});
afterEach(async () => {
  await stopTestBoss(boss);
  await clearNamespace(ns);
  await t.close();
});

function app() {
  const hono = new Hono();
  hono.use('*', actAs());
  hono.route('/api', createDiscoveryRouter(deps.discovery));
  return hono;
}
const send = (method: string, path: string, body?: unknown, actor = 'u_1') =>
  app().request(`/api${path}`, {
    method,
    headers: { [ACT_AS]: actor, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const answered = await res;
  expect(answered.status).toBe(status);
  return (await answered.json()) as T;
}

/** An Italian word with one sense, its Hebrew the proposal's: its lookup is served from the
 *  dictionary, and its gloss chosen by rule. */
async function italian(lemma: string, hebrew: string): Promise<string> {
  const ids = await insertLexeme(t.db, {
    lemma,
    languageCode: 'it',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: [{ senseCode: 's0' }],
    variants: [
      {
        form: lemma,
        kind: 'word',
        entryRank: 0,
        translations: [{ senseCode: 's0', rank: 0, translation: hebrew, exampleSource: null, exampleTarget: null }],
      },
    ],
  });
  return ids.glossIds[0];
}

describe('Words for me over HTTP (phase 69, spec D2–D10)', () => {
  it('runs from the questions to My words: two rounds, a judged answer, a list, an untick and a save', async () => {
    const WORDS: [string, string][] = [
      ['gatto', 'חתול'],
      ['cane', 'כלב'],
      ['pane', 'לחם'],
      ['mare', 'ים'],
      ['casa', 'בית'],
      ['sole', 'שמש'],
    ];
    const gloss: Record<string, string> = {};
    for (const [lemma, hebrew] of WORDS) gloss[lemma] = await italian(lemma, hebrew);

    expect(await ok<DiscoveryState>(send('GET', `/enrollments/${IT}/discovery`))).toEqual({ profile: null, run: null });
    expect(await ok(send('POST', `/enrollments/${IT}/discovery/profile`, { self_level: 'simple', learning_context: 'self' }), 201)).toEqual({
      self_level: 'simple',
      learning_context: 'self',
      level: 3,
    });
    expect((await send('POST', `/enrollments/${IT}/discovery/profile`, { self_level: 'none', learning_context: 'self' })).status).toBe(409);

    const run = await ok<DiscoveryRun>(send('POST', `/enrollments/${IT}/discovery/runs`, { goal: 3 }), 201);
    expect(run).toMatchObject({ goal: 3, status: 'asking', round: 0, cards: [] });
    expect((await send('POST', `/enrollments/${IT}/discovery/runs`, { goal: 5 })).status).toBe(200);

    await expectDiscovery(ns, WORDS.slice(0, 4).map(([word, hebrew]) => ({ word, hebrew })));
    const first = await ok<DiscoveryRun>(send('POST', `/discovery/runs/${run.id}/rounds`));
    expect(first.cards.map((card) => card.word)).toEqual(['gatto', 'cane', 'pane', 'mare']);

    const answer = (position: number, body: unknown) => send('POST', `/discovery/runs/${run.id}/cards/${position}/answer`, body);
    expect(await ok<DiscoveryAnswerResult>(answer(0, { kind: 'typed', text: 'חתול' }))).toMatchObject({ known: true, meaning: 'חתול' });
    expect((await answer(1, { kind: 'typed', text: 'dog' })).status).toBe(422);
    await expectJudge(ns, 'wrong');
    expect(await ok<DiscoveryAnswerResult>(answer(1, { kind: 'typed', text: 'גור' }))).toMatchObject({ known: false, meaning: 'כלב' });
    await ok(answer(2, { kind: 'typed', text: 'לחם' }));
    const roundDone = await ok<DiscoveryAnswerResult>(answer(3, { kind: 'typed', text: 'ים' }));
    expect(roundDone.run).toMatchObject({ status: 'asking', unknown_count: 1, cards: [] });

    // The second round leaves out what the learner answered: gatto comes back and is dropped.
    await expectDiscovery(ns, [
      { word: 'gatto', hebrew: 'חתול' },
      { word: 'casa', hebrew: 'בית' },
      { word: 'sole', hebrew: 'שמש' },
    ]);
    const second = await ok<DiscoveryRun>(send('POST', `/discovery/runs/${run.id}/rounds`));
    expect(second.cards).toEqual([
      { position: 4, word: 'casa' },
      { position: 5, word: 'sole' },
    ]);
    expect(await countGeminiRequests(ns, 'pane')).toBe(1);

    await ok(answer(4, { kind: 'unknown' }));
    const listed = await ok<DiscoveryAnswerResult>(answer(5, { kind: 'unknown' }));
    expect(listed.run).toMatchObject({ status: 'listing', unknown_count: 3, cards: [] });
    expect(listed.run.items.map((item) => item.text)).toEqual(['cane', 'casa', 'sole']);

    // The lookups run in the background; the list is ready once none is pending.
    let list = listed.run;
    await waitFor(async () => {
      list = await ok<DiscoveryRun>(send('GET', `/discovery/runs/${run.id}`));
      return list.items.every((item) => item.status !== 'pending');
    });
    expect(list.items.map((item) => [item.text, item.status, item.chosen_gloss_id, item.ticked])).toEqual([
      ['cane', 'ready', gloss.cane, true],
      ['casa', 'ready', gloss.casa, true],
      ['sole', 'ready', gloss.sole, true],
    ]);

    expect(await ok(send('PATCH', `/discovery/runs/${run.id}/items/5`, { ticked: false }))).toMatchObject({ position: 5, ticked: false });
    const saved = await ok<{ saved_gloss_ids: string[] }>(send('POST', `/discovery/runs/${run.id}/save`));
    expect([...saved.saved_gloss_ids].sort()).toEqual([gloss.cane, gloss.casa].sort());
    expect(await readSavedGlossIds(t.db, IT)).toEqual([gloss.cane, gloss.casa].sort());
    expect(await ok(send('POST', `/discovery/runs/${run.id}/save`))).toEqual(saved);

    // Three of four known moved the level up one; the second round, two cards, kept it.
    expect(await ok<DiscoveryState>(send('GET', `/enrollments/${IT}/discovery`))).toEqual({
      profile: { self_level: 'simple', learning_context: 'self', level: 4 },
      run: null,
    });
  });

  // Review Focus 1, against Postgres: the run's row lock, not a fake's.
  it('writes one round when two are asked at once', async () => {
    await seedDiscoveryProfile(t.db, { enrollmentId: IT });
    const run = await ok<DiscoveryRun>(send('POST', `/enrollments/${IT}/discovery/runs`, { goal: 5 }), 201);
    const words = ['uno', 'due', 'tre'].map((word) => ({ word, hebrew: 'משהו' }));
    await expectDiscovery(ns, words);
    await expectDiscovery(ns, words);
    const both = await Promise.all([send('POST', `/discovery/runs/${run.id}/rounds`), send('POST', `/discovery/runs/${run.id}/rounds`)]);
    expect(both.map((res) => res.status)).toEqual([200, 200]);
    const after = await ok<DiscoveryRun>(send('GET', `/discovery/runs/${run.id}`));
    expect(after).toMatchObject({ round: 1, cards: [{ position: 0 }, { position: 1 }, { position: 2 }] });
  });

  // The goal is the one rule no constraint backs: two answers at once must still see each other.
  it('lists the run when two answers at once reach the goal, settling the round once', async () => {
    await seedDiscoveryProfile(t.db, { enrollmentId: IT, level: 5 });
    const id = await seedDiscoveryRun(t.db, {
      enrollmentId: IT,
      status: 'asking',
      goal: 4,
      cards: [
        { word: 'uno', answer: 'unknown' },
        { word: 'due', answer: 'unknown', options: [] },
        { word: 'tre', answer: null },
        { word: 'quattro', answer: null },
      ],
    });
    const both = await Promise.all([
      send('POST', `/discovery/runs/${id}/cards/2/answer`, { kind: 'unknown' }),
      send('POST', `/discovery/runs/${id}/cards/3/answer`, { kind: 'unknown' }),
    ]);
    expect(both.map((res) => res.status)).toEqual([200, 200]);
    expect(await ok<DiscoveryRun>(send('GET', `/discovery/runs/${id}`))).toMatchObject({ status: 'listing', unknown_count: 4 });
    // Four answered, none known: down two, once.
    expect(await ok<DiscoveryState>(send('GET', `/enrollments/${IT}/discovery`))).toMatchObject({ profile: { level: 3 }, run: { status: 'listing' } });
  });

  it('answers 502 when the model cannot propose words, and the run asks on', async () => {
    await seedDiscoveryProfile(t.db, { enrollmentId: IT });
    const run = await ok<DiscoveryRun>(send('POST', `/enrollments/${IT}/discovery/runs`, { goal: 5 }), 201);
    const res = await send('POST', `/discovery/runs/${run.id}/rounds`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'words unavailable' });
    expect(await ok<DiscoveryRun>(send('GET', `/discovery/runs/${run.id}`))).toMatchObject({ status: 'asking', cards: [] });
  });

  it('refuses a run before the questions (409), and a stranger (403)', async () => {
    expect((await send('POST', `/enrollments/${IT}/discovery/runs`, { goal: 5 })).status).toBe(409);
    expect((await send('GET', `/enrollments/${IT}/discovery`, undefined, 'u_2')).status).toBe(403);
    const id = await seedDiscoveryRun(t.db, { enrollmentId: IT, status: 'asking', cards: [{ word: 'gatto', answer: null }] });
    expect((await send('POST', `/discovery/runs/${id}/cards/0/answer`, { kind: 'unknown' }, 'u_2')).status).toBe(403);
  });

  it('ends a run early, discards it, and refuses a save of a discarded run', async () => {
    await seedDiscoveryProfile(t.db, { enrollmentId: IT });
    const id = await seedDiscoveryRun(t.db, {
      enrollmentId: IT,
      status: 'asking',
      cards: [
        { word: 'gatto', answer: 'unknown' },
        { word: 'cane', answer: null },
      ],
    });
    expect(await ok(send('POST', `/discovery/runs/${id}/end`))).toMatchObject({ status: 'listing', unknown_count: 1, cards: [] });
    expect((await send('POST', `/discovery/runs/${id}/discard`)).status).toBe(204);
    expect((await send('POST', `/discovery/runs/${id}/discard`)).status).toBe(204);
    expect((await send('POST', `/discovery/runs/${id}/save`)).status).toBe(409);
    expect((await send('GET', `/discovery/runs/nope`)).status).toBe(404);
  });
});
