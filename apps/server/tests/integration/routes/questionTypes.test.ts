import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import { PREPARE_SESSION } from '../../../src/domain/jobs';
import { createQuestionTypesRouter } from '../../../src/routes/questionTypes';
import { ACT_AS, actAs } from '../../support/actAs';
import { createFakeLogger } from '../../support/fakes';
import { seedGrant } from '../../support/grantRows';
import { jobPayloads } from '../../support/jobs';
import { insertListSession } from '../../support/questions';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedUser, setTester } from '../../support/seedUser';
import { markSeed, markStarted, readSessionPaths, readSessionRows, seedPastSession } from '../../support/sessionRows';
import { seedTarget } from '../../support/targetRows';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

// Phase 61 (spec D1–D3). The read of one saved meaning's question types, and the
// session of the chosen ones, through the router production mounts.
let t: TestDb;
const OWNER = 'u_1';
const ENROLLMENT = enrollmentOf(OWNER);
let word: Awaited<ReturnType<typeof seedSavedSenses>>;

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, OWNER);
  // Two meanings of one word: the second makes new_meaning possible for the first.
  word = await seedSavedSenses(t.db, {
    enrollmentId: ENROLLMENT,
    lemma: 'house',
    translations: ['בית', 'משכן'],
    example: { source: 'The house is big.', target: 'הבית גדול.' },
  });
  await makeTester(OWNER);
});

afterEach(async () => {
  await t.close();
});

const makeTester = (userId: string, on = true) => setTester(t.db, userId, on);

function app() {
  const deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });
  const hono = new Hono();
  hono.use('*', actAs());
  hono.route('/api', createQuestionTypesRouter(deps.questionTypes));
  return hono;
}

const read = (query: Record<string, string>, actor = OWNER, enrollmentId = ENROLLMENT) =>
  app().request(`/api/enrollments/${enrollmentId}/vocabulary/question-types?${new URLSearchParams(query)}`, {
    headers: { [ACT_AS]: actor },
  });

const create = (body: Record<string, unknown>, actor = OWNER, enrollmentId = ENROLLMENT) =>
  app().request(`/api/enrollments/${enrollmentId}/question-type-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [ACT_AS]: actor },
    body: JSON.stringify(body),
  });

const first = () => ({ gloss_id: word.glossIds[0], variant_id: word.variantId });
type Read = { sense_id: string; types: { type: string; available: boolean; reason?: string }[] };

async function readFirst(devices = { listening: 'true', speaking: 'true' }): Promise<Read> {
  const res = await read({ ...first(), ...devices });
  expect(res.status).toBe(200);
  return (await res.json()) as Read;
}

/** The enrollment's sessions but the past one a POST test starts from. */
let past: string | null = null;
const sessionRows = async () => (await readSessionRows(t.db, ENROLLMENT)).filter((row) => row.id !== past);

describe('GET question-types', () => {
  it('lists all fifteen types for the fixed rendering, with a reason for each the word cannot have', async () => {
    const body = await readFirst();
    expect(body.sense_id).toBe(word.senseIds[0]);
    expect(body.types).toHaveLength(15);
    const of = (type: string) => body.types.find((entry) => entry.type === type);
    expect(of('matching')).toEqual({ type: 'matching', available: false, reason: 'needs_more_words' });
    expect(of('cloze_choice')).toEqual({ type: 'cloze_choice', available: true });
    expect(of('new_meaning')).toEqual({ type: 'new_meaning', available: true });
  });

  it("names the device's reasons and the word's", async () => {
    const body = await readFirst({ listening: 'false', speaking: 'false' });
    const reason = (type: string) => body.types.find((entry) => entry.type === type)?.reason;
    expect(reason('dictation')).toBe('no_voice');
    expect(reason('read_aloud')).toBe('no_microphone');
    // The second meaning has no example of its own.
    const second = await read({ gloss_id: word.glossIds[1], variant_id: word.variantId });
    expect(((await second.json()) as Read).types.find((entry) => entry.type === 'cloze_choice')?.reason).toBe('no_example_gap');
  });

  it('answers no_other_meaning for a word with one saved meaning', async () => {
    const lone = await seedSavedSenses(t.db, { enrollmentId: ENROLLMENT, lemma: 'tree', translations: ['עץ'] });
    const res = await read({ gloss_id: lone.glossIds[0], variant_id: lone.variantId });
    expect(((await res.json()) as Read).types.find((entry) => entry.type === 'new_meaning')?.reason).toBe('no_other_meaning');
  });

  it('is 403 not_a_tester for an owner who is not a tester', async () => {
    await makeTester(OWNER, false);
    const res = await read(first());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_a_tester' });
  });

  it("is 403 for a tutor of the list, even a tester: practice is the owner's", async () => {
    await seedUser(t.db, 'u_tutor');
    await makeTester('u_tutor');
    await seedGrant(t.db, { enrollmentId: ENROLLMENT, ownerUserId: OWNER, granteeUserId: 'u_tutor', accepted: true });
    expect((await read(first(), 'u_tutor')).status).toBe(403);
    expect((await create({ ...first(), sense_id: word.senseIds[0], types: ['meet'], listening: false, speaking: false }, 'u_tutor')).status).toBe(403);
  });

  it('is 404 gloss_not_saved for a gloss the list does not hold', async () => {
    const res = await read({ gloss_id: 'g_nowhere', variant_id: word.variantId });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'gloss_not_saved' });
  });
});

describe('POST question-type-sessions', () => {
  beforeEach(async () => {
    past = await seedPastSession(t.db, OWNER, ENROLLMENT);
  });

  const body = (types: string[], extra: Record<string, unknown> = {}) => ({
    ...first(),
    sense_id: word.senseIds[0],
    types,
    listening: true,
    speaking: true,
    ...extra,
  });

  it('inserts a preparing question-types session, chosen on no day, and enqueues the chosen types in order', async () => {
    const res = await create(body(['dictation', 'meet', 'new_meaning']));
    expect(res.status).toBe(201);
    const created = (await res.json()) as { session_id: string; status: string };
    expect(created.status).toBe('preparing');
    expect(await sessionRows()).toEqual([{ id: created.session_id, status: 'preparing', kind: 'question_types', chosen_on: null }]);
    const [payload] = (await jobPayloads(t.db, PREPARE_SESSION)) as Record<string, unknown>[];
    expect(payload).toMatchObject({
      session_id: created.session_id,
      question_types: ['meet', 'new_meaning', 'dictation'],
      listening: true,
      speaking: true,
      picks: [{ gloss_id: word.glossIds[0], sense_id: word.senseIds[0], variant_id: word.variantId, known_meanings: ['משכן'] }],
    });
  });

  it('retires a list session waiting in stock, and takes its place', async () => {
    const { sessionId: stock } = await insertListSession(t.db, {
      userId: OWNER,
      enrollmentId: ENROLLMENT,
      asked: [{ glossId: word.glossIds[0], variantId: word.variantId, lexemeId: word.lexemeId, form: 'house', lemma: 'house', translation: 'בית' }],
    });
    const res = await create(body(['meet']));
    expect(res.status).toBe(201);
    const rows = await sessionRows();
    expect(rows.find((row) => row.id === stock)?.status).toBe('skipped');
    expect(rows.filter((row) => row.kind === 'question_types').map((row) => row.status)).toEqual(['preparing']);
  });

  it('is 409 session_open while a session is started, and writes nothing', async () => {
    const { sessionId } = await insertListSession(t.db, {
      userId: OWNER,
      enrollmentId: ENROLLMENT,
      asked: [{ glossId: word.glossIds[0], variantId: word.variantId, lexemeId: word.lexemeId, form: 'house', lemma: 'house', translation: 'בית' }],
    });
    await markStarted(t.db, sessionId);
    const res = await create(body(['meet']));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'session_open' });
    expect((await sessionRows()).length).toBe(1);
  });

  // Phase 57 (ADR 0014). The session is the main path's: a target's started session and its
  // stock are another path's, neither refuses it nor is retired, and it never reads as theirs.
  it("is the main path's, leaving a target path's started session and stock as they are", async () => {
    const target = await seedTarget(t.db, { enrollmentId: ENROLLMENT, kind: 'exam', dueOn: '2030-01-13', glossIds: [word.glossIds[1]] });
    const asked = [{ glossId: word.glossIds[1], variantId: word.variantId, lexemeId: word.lexemeId, form: 'house', lemma: 'house', translation: 'משכן' }];
    const { sessionId: started } = await insertListSession(t.db, { userId: OWNER, enrollmentId: ENROLLMENT, asked, targetId: target });
    await markStarted(t.db, started);
    const { sessionId: stock } = await insertListSession(t.db, { userId: OWNER, enrollmentId: ENROLLMENT, asked, targetId: target });

    const res = await create(body(['meet']));
    expect(res.status).toBe(201);
    const created = ((await res.json()) as { session_id: string }).session_id;
    const rows = (await readSessionPaths(t.db, ENROLLMENT)).filter((row) => row.id !== past);
    expect(rows).toEqual([
      { id: started, status: 'ready', kind: 'practice', target_id: target, started: true },
      { id: stock, status: 'ready', kind: 'practice', target_id: target, started: false },
      { id: created, status: 'preparing', kind: 'question_types', target_id: null, started: false },
    ]);
  });

  it('is 409 seed_pending while the first, seeded session waits in stock', async () => {
    const { sessionId } = await insertListSession(t.db, {
      userId: OWNER,
      enrollmentId: ENROLLMENT,
      asked: [{ glossId: word.glossIds[0], variantId: word.variantId, lexemeId: word.lexemeId, form: 'house', lemma: 'house', translation: 'בית' }],
    });
    await markSeed(t.db, sessionId);
    const res = await create(body(['meet']));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'seed_pending' });
  });

  it('is 400 question_type_unavailable for a type the word or device cannot have', async () => {
    const res = await create(body(['matching']));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'question_type_unavailable' });
    expect((await create(body(['dictation'], { listening: false }))).status).toBe(400);
    expect(await sessionRows()).toEqual([]);
  });

  it('is 400 rendering_mismatch when sense_id is not the rendering the read answered', async () => {
    const res = await create(body(['meet'], { sense_id: word.senseIds[1] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'rendering_mismatch' });
  });

  it('is 400 for a repeated type, and 403 not_a_tester for a non-tester', async () => {
    expect((await create(body(['meet', 'meet']))).status).toBe(400);
    await makeTester(OWNER, false);
    const res = await create(body(['meet']));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_a_tester' });
  });
});

// Final review (minor 4). Before any session, the next one is the seed: none may take its place.
describe('POST question-type-sessions on a new enrollment', () => {
  it('is 409 seed_pending before the enrollment has had any session, and writes nothing', async () => {
    const res = await create({ ...first(), sense_id: word.senseIds[0], types: ['meet'], listening: false, speaking: false });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'seed_pending' });
    expect(await readSessionRows(t.db, ENROLLMENT)).toEqual([]);
  });
});
