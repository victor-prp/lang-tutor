import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { DiscoveryRun, DiscoveryState } from '@lang-tutor/core/api';
import { Hono } from 'hono';
import type { PgBoss } from 'pg-boss';

import type { AppDeps } from '../../../src/composition';
import { createDiscoveryRouter } from '../../../src/routes/discovery';
import { registerWorkers } from '../../../src/worker';
import { ACT_AS, actAs } from '../../support/actAs';
import { insertLexeme } from '../../support/dictRows';
import { clearCardChoices, seedDiscoveryProfile, seedDiscoveryRun, setRunStatus } from '../../support/discoveryRows';
import { createFakeLogger } from '../../support/fakes';
import { startTestBoss, stockJobKeys, stopTestBoss, waitFor } from '../../support/jobs';
import { assertMockServerReachable, clearNamespace, countGeminiRequests, expectDiscovery, geminiBaseUrlFor, mockNamespace } from '../../support/mockServer';
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

describe('Words for me over HTTP (phase 69, spec D2–D10; phase 74)', () => {
  it('runs from the questions to My words: two rounds of choices, words added per card, the end, the saves', async () => {
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

    // The app starts the run: the learner's count, 10 by default.
    const run = await ok<DiscoveryRun>(send('POST', `/enrollments/${IT}/discovery/runs`, { goal: null }), 201);
    expect(run).toMatchObject({ goal: 10, status: 'asking', started_by: 'app', added_count: 0, round: 0, cards: [], added: [] });
    expect((await send('POST', `/enrollments/${IT}/discovery/runs`, { goal: 5 })).status).toBe(200);

    await expectDiscovery(ns, WORDS.slice(0, 4).map(([word, hebrew]) => ({ word, hebrew })));
    const first = await ok<DiscoveryRun>(send('POST', `/discovery/runs/${run.id}/rounds`));
    expect(first.cards.map((card) => card.word)).toEqual(['gatto', 'cane', 'pane', 'mare']);
    for (const [index, card] of first.cards.entries()) {
      expect([...card.choices].sort()).toEqual([WORDS[index][1], 'אחר', 'שונה', 'רחוק'].sort());
      expect(card.choices[card.right]).toBe(WORDS[index][1]);
    }
    const right = (position: number) => first.cards.find((card) => card.position === position)!.right;

    const answer = (position: number, body: unknown) => send('POST', `/discovery/runs/${run.id}/cards/${position}/answer`, body);
    expect(await ok<DiscoveryRun>(answer(0, { pick: right(0), add: false }))).toMatchObject({ added_count: 0 });
    expect((await answer(1, { pick: 4, add: true })).status).toBe(400);
    expect(await ok<DiscoveryRun>(answer(1, { pick: (right(1) + 1) % 4, add: true }))).toMatchObject({
      added_count: 1,
      added: [{ position: 1, word: 'cane', meaning: 'כלב' }],
    });
    await ok(answer(2, { pick: null, add: true }));
    const roundDone = await ok<DiscoveryRun>(answer(3, { pick: right(3), add: false }));
    expect(roundDone).toMatchObject({ status: 'asking', added_count: 2, cards: [] });

    // The second round leaves out what the learner answered: gatto comes back and is dropped.
    await expectDiscovery(ns, [
      { word: 'gatto', hebrew: 'חתול' },
      { word: 'casa', hebrew: 'בית' },
      { word: 'sole', hebrew: 'שמש' },
    ]);
    const second = await ok<DiscoveryRun>(send('POST', `/discovery/runs/${run.id}/rounds`));
    expect(second.cards.map((card) => [card.position, card.word])).toEqual([
      [4, 'casa'],
      [5, 'sole'],
    ]);
    expect(await countGeminiRequests(ns, 'pane')).toBe(1);

    await ok(answer(4, { pick: null, add: true }));
    // ✕ with words added ends the run; sole was never answered.
    const ended = await ok<DiscoveryRun>(send('POST', `/discovery/runs/${run.id}/end`));
    expect(ended).toMatchObject({ status: 'saved', added_count: 3, cards: [] });
    expect(ended.added.map((word) => word.word)).toEqual(['cane', 'pane', 'casa']);

    // The lookups run in the background and save each word as they land, the run ended or not.
    let after = ended;
    await waitFor(async () => {
      after = await ok<DiscoveryRun>(send('GET', `/discovery/runs/${run.id}`));
      return after.added.every((word) => word.status !== 'pending');
    });
    expect(after.added.map((word) => [word.word, word.meaning, word.status])).toEqual([
      ['cane', 'כלב', 'saved'],
      ['pane', 'לחם', 'saved'],
      ['casa', 'בית', 'saved'],
    ]);
    expect(await readSavedGlossIds(t.db, IT)).toEqual([gloss.cane, gloss.pane, gloss.casa].sort());
    // The run's saves asked for the session at once, never by the delayed save stock.
    const stocks = await stockJobKeys(t.db);
    expect(stocks.map((job) => job.data.reason)).toContain('discovery');
    expect(stocks.map((job) => job.data.reason)).not.toContain('save');

    // Two of four known in the first round kept the level; the second round, one card, too.
    expect(await ok<DiscoveryState>(send('GET', `/enrollments/${IT}/discovery`))).toEqual({
      profile: { self_level: 'simple', learning_context: 'self', level: 3 },
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
  it('ends the run when two answers at once add the goal, settling the round once', async () => {
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
      send('POST', `/discovery/runs/${id}/cards/2/answer`, { pick: null, add: true }),
      send('POST', `/discovery/runs/${id}/cards/3/answer`, { pick: null, add: true }),
    ]);
    expect(both.map((res) => res.status)).toEqual([200, 200]);
    expect(await ok<DiscoveryRun>(send('GET', `/discovery/runs/${id}`))).toMatchObject({ status: 'saved', added_count: 4 });
    // Four answered, none known: down two, once.
    expect(await ok<DiscoveryState>(send('GET', `/enrollments/${IT}/discovery`))).toMatchObject({ profile: { level: 3 }, run: null });
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
    expect((await send('POST', `/discovery/runs/${id}/cards/0/answer`, { pick: null, add: true }, 'u_2')).status).toBe(403);
  });

  it("refuses a pick past a card's choices (400), and ends a run once, refusing a discarded one", async () => {
    await seedDiscoveryProfile(t.db, { enrollmentId: IT });
    const id = await seedDiscoveryRun(t.db, {
      enrollmentId: IT,
      status: 'asking',
      cards: [
        { word: 'gatto', answer: 'unknown' },
        { word: 'cane', answer: null },
      ],
    });
    // A card of phase 69 has no choices: no pick is one of them.
    await clearCardChoices(t.db, id, 1);
    const bad = await send('POST', `/discovery/runs/${id}/cards/1/answer`, { pick: 0, add: false });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid pick' });

    expect(await ok(send('POST', `/discovery/runs/${id}/end`))).toMatchObject({ status: 'saved', added_count: 1, cards: [] });
    expect(await ok(send('POST', `/discovery/runs/${id}/end`))).toMatchObject({ status: 'saved' });
    await setRunStatus(t.db, id, 'discarded');
    expect((await send('POST', `/discovery/runs/${id}/end`)).status).toBe(409);
    expect((await send('GET', `/discovery/runs/nope`)).status).toBe(404);
  });
});
