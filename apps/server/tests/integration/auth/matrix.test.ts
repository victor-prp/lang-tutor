import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createApp } from '../../../src/app';
import { signUpWithProfile } from '../../support/auth';
import { insertLexeme } from '../../support/dictRows';
import { seedDiscoveryProfile, seedDiscoveryRun } from '../../support/discoveryRows';
import { createFakeLogger } from '../../support/fakes';
import { addedByOf, seedGrant } from '../../support/grantRows';
import { clearNamespace, expectEmails, mailBaseUrlFor, mockNamespace } from '../../support/mockServer';
import { seedPhotoImport } from '../../support/photoImportRows';
import { countRows } from '../../support/rowCounts';
import { createTestServerDeps } from '../../support/serverDeps';
import { setTester } from '../../support/seedUser';
import { seedTarget } from '../../support/targetRows';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

// Phase 29 (spec D13). The whole app and its published document: every
// operation the document lists is either open, the caller's own by
// construction, or aimed below at another learner's things — and a new
// operation that is none of the three fails the fixture check until someone
// decides which it is.

type Op = { method: string; path: string };
type Doc = { paths: Record<string, Record<string, unknown>> };
type Account = { cookie: string; userId: string };

let t: TestDb;
let ns: string;
let app: ReturnType<typeof createApp>;
let owner: Account;
let stranger: Account;
let tutor: Account;
// The owner's things, filled in beforeAll.
let ids: {
  enrollment: string;
  session: string;
  photoImport: string;
  discoveryRun: string;
  target: string;
  grant: string;
  saved: { gloss_id: string; variant_id: string };
  unsaved: { gloss_id: string; variant_id: string };
};

const LEMMA = 'matrix';

const OPEN = new Set([
  'get /health',
  'post /api/auth/email-otp/send-verification-otp',
  'post /api/auth/sign-in/email-otp',
  'get /api/auth/get-session',
  'post /api/auth/sign-out',
]);

/** Operations that never address another user's things: each acts on the caller's own. */
const OWN_ONLY = new Set([
  'get /api/me',
  'put /api/me/time-zone', // acts on c.var.actor only (phase 52)
  // Phase 52 (spec D2, D4, D6). Each acts on c.var.actor and no one else. The tap names a reminder
  // in its path, but it finds it only under the caller's id: a stranger's reminder answers 404, the
  // same as a missing one, so it has no 403 for the stranger fixtures to expect. Asserted in
  // routes/reminders.test.ts.
  'get /api/me/reminders',
  'put /api/me/reminders',
  'put /api/me/push-devices',
  'post /api/me/push-devices/unregister',
  'post /api/me/reminders/{id}/tap',
  // Phase 70 (spec D5). The learner's own new-word limits.
  'get /api/me/new-words',
  'put /api/me/new-words',
  'post /api/users',
  'get /api/enrollments',
  'post /api/enrollments',
  'get /api/grants',
  'post /api/grants', // invites by username; its refusals are the invite rules' (phase 28)
]);

/**
 * How a stranger aims each remaining operation at the owner's things. Every
 * body passes its route's validation, so a 400 here is a failure, not a pass.
 * A save aims at a gloss the owner has not saved and an unsave at one they
 * have, so either getting through would show in the row counts as well as the
 * answer.
 */
const STRANGER: Record<string, () => { url: string; body?: unknown }> = {
  'post /api/sessions': () => ({ url: '/api/sessions', body: { enrollment_id: ids.enrollment } }),
  'get /api/sessions/{id}': () => ({ url: `/api/sessions/${ids.session}` }),
  'post /api/sessions/{id}/skip': () => ({ url: `/api/sessions/${ids.session}/skip` }),
  // Phase 43 (spec D2).
  'post /api/sessions/{id}/start': () => ({ url: `/api/sessions/${ids.session}/start`, body: {} }),
  'post /api/sessions/{id}/next-step': () => ({
    url: `/api/sessions/${ids.session}/next-step`,
    body: { question_id: 'q', option_index: 0 },
  }),
  'post /api/sessions/{id}/speech': () => ({
    url: `/api/sessions/${ids.session}/speech`,
    body: { question_id: 'q', mime_type: 'audio/aac', audio: 'AAAA' },
  }),
  'post /api/sessions/{id}/judged-answer': () => ({
    url: `/api/sessions/${ids.session}/judged-answer`,
    body: { question_id: 'q', text: 'x' },
  }),
  // Phase 66 (spec D2).
  'post /api/sessions/{id}/explain': () => ({
    url: `/api/sessions/${ids.session}/explain`,
    body: { question_id: 'q' },
  }),
  'get /api/enrollments/{id}/sessions/current': () => ({ url: `/api/enrollments/${ids.enrollment}/sessions/current` }),
  'get /api/enrollments/{id}/vocabulary': () => ({ url: `/api/enrollments/${ids.enrollment}/vocabulary` }),
  'post /api/enrollments/{id}/vocabulary': () => ({
    url: `/api/enrollments/${ids.enrollment}/vocabulary`,
    body: { entries: [ids.unsaved] },
  }),
  // Phase 58. The owner's saved word is new (level 1), so a removal that got
  // through would show in the count of vocabulary_entries.
  'delete /api/enrollments/{id}/vocabulary': () => ({ url: `/api/enrollments/${ids.enrollment}/vocabulary?level=1` }),
  'delete /api/enrollments/{id}/vocabulary/glosses/{gloss_id}': () => ({
    url: `/api/enrollments/${ids.enrollment}/vocabulary/glosses/${ids.saved.gloss_id}`,
  }),
  'get /api/enrollments/{id}/vocabulary/word': () => ({
    url: `/api/enrollments/${ids.enrollment}/vocabulary/word?lemma=${LEMMA}`,
  }),
  // Phase 61 (spec D1). The stranger and the tutor are testers, so what refuses them is the
  // owner's check, not the flag. A session that got through would show in the count of sessions.
  'get /api/enrollments/{id}/vocabulary/question-types': () => ({
    url: `/api/enrollments/${ids.enrollment}/vocabulary/question-types?gloss_id=${ids.saved.gloss_id}&variant_id=${ids.saved.variant_id}`,
  }),
  'post /api/enrollments/{id}/question-type-sessions': () => ({
    url: `/api/enrollments/${ids.enrollment}/question-type-sessions`,
    body: { ...ids.saved, sense_id: 's', types: ['meet'], listening: false, speaking: false },
  }),
  'post /api/enrollments/{id}/photo-imports': () => ({
    url: `/api/enrollments/${ids.enrollment}/photo-imports`,
    body: { mime_type: 'image/jpeg', image: 'AAAA' },
  }),
  'get /api/enrollments/{id}/photo-imports': () => ({ url: `/api/enrollments/${ids.enrollment}/photo-imports` }),
  'get /api/photo-imports/{id}': () => ({ url: `/api/photo-imports/${ids.photoImport}` }),
  'patch /api/photo-imports/{id}/items/{position}': () => ({
    url: `/api/photo-imports/${ids.photoImport}/items/0`,
    body: { ticked: false },
  }),
  'post /api/photo-imports/{id}/save': () => ({ url: `/api/photo-imports/${ids.photoImport}/save` }),
  'post /api/enrollments/{id}/photo-imports/save': () => ({
    url: `/api/enrollments/${ids.enrollment}/photo-imports/save`,
    body: { photo_import_ids: [ids.photoImport] },
  }),
  'post /api/photo-imports/{id}/discard': () => ({ url: `/api/photo-imports/${ids.photoImport}/discard` }),
  // Phase 69 (spec D10). Words for me is its list owner's alone, a tutor of the list included. A
  // call that got through would show in the counts of discovery_profiles, discovery_runs or
  // discovery_cards, or in the run's status or its first card's answer.
  'get /api/enrollments/{id}/discovery': () => ({ url: `/api/enrollments/${ids.enrollment}/discovery` }),
  'post /api/enrollments/{id}/discovery/profile': () => ({
    url: `/api/enrollments/${ids.enrollment}/discovery/profile`,
    body: { self_level: 'none', learning_context: 'self' },
  }),
  'post /api/enrollments/{id}/discovery/runs': () => ({ url: `/api/enrollments/${ids.enrollment}/discovery/runs`, body: { goal: 5 } }),
  'get /api/discovery/runs/{id}': () => ({ url: `/api/discovery/runs/${ids.discoveryRun}` }),
  'post /api/discovery/runs/{id}/rounds': () => ({ url: `/api/discovery/runs/${ids.discoveryRun}/rounds` }),
  'post /api/discovery/runs/{id}/cards/{position}/answer': () => ({
    url: `/api/discovery/runs/${ids.discoveryRun}/cards/0/answer`,
    body: { pick: null, add: true },
  }),
  'post /api/discovery/runs/{id}/end': () => ({ url: `/api/discovery/runs/${ids.discoveryRun}/end` }),
  // Phase 73 (spec D1). The My words goal is its course owner's alone, a tutor included. A PUT that
  // got through would show in enrollments.my_words_goal.
  'get /api/enrollments/{id}/my-words-goal': () => ({ url: `/api/enrollments/${ids.enrollment}/my-words-goal` }),
  'put /api/enrollments/{id}/my-words-goal': () => ({
    url: `/api/enrollments/${ids.enrollment}/my-words-goal`,
    body: { goal: 9 },
  }),
  // Phase 53 (spec D2). A target is its list owner's alone, a tutor of the list included: the
  // tutor loop below is refused on all seven too. A call that got through would show in the
  // counts of targets, target_words, target_events or vocabulary_entries (the add aims at a gloss
  // the owner has not saved, the removal at one their target holds), or in the target's state.
  'get /api/enrollments/{id}/targets': () => ({ url: `/api/enrollments/${ids.enrollment}/targets` }),
  'post /api/enrollments/{id}/targets': () => ({
    url: `/api/enrollments/${ids.enrollment}/targets`,
    body: { kind: 'exam', due_on: '2099-01-01', photo_import_ids: [], entries: [ids.saved] },
  }),
  'get /api/targets/{id}': () => ({ url: `/api/targets/${ids.target}` }),
  'patch /api/targets/{id}': () => ({ url: `/api/targets/${ids.target}`, body: { due_on: '2099-02-01' } }),
  'post /api/targets/{id}/end': () => ({ url: `/api/targets/${ids.target}/end` }),
  'post /api/targets/{id}/words': () => ({
    url: `/api/targets/${ids.target}/words`,
    body: { photo_import_ids: [], entries: [ids.unsaved] },
  }),
  'delete /api/targets/{id}/words/{gloss_id}': () => ({
    url: `/api/targets/${ids.target}/words/${ids.saved.gloss_id}`,
  }),
  // The enrollment is named only in the body (Review Focus 5). Its pair is the
  // request's, so a missing check would reach the model rather than a 400.
  'post /api/translations': () => ({
    url: '/api/translations',
    body: { text: LEMMA, from: 'en', to: 'he', enrollment_id: ids.enrollment },
  }),
  'post /api/grants/{id}/accept': () => ({ url: `/api/grants/${ids.grant}/accept` }),
  'delete /api/grants/{id}': () => ({ url: `/api/grants/${ids.grant}` }),
};

/** With an accepted grant, the tutor may do exactly these to the student's things. */
const TUTOR_ALLOWED = new Set(['post /api/enrollments/{id}/vocabulary', 'delete /api/grants/{id}']);

async function operations(): Promise<Op[]> {
  const res = await app.request('/openapi.json');
  expect(res.status).toBe(200);
  const doc = (await res.json()) as Doc;
  return Object.entries(doc.paths).flatMap(([path, ops]) => Object.keys(ops).map((method) => ({ method, path })));
}
const key = (op: Op) => `${op.method} ${op.path}`;
const methodOf = (k: string) => k.split(' ')[0];
const call = (method: string, url: string, cookie: string | null, body?: unknown) =>
  app.request(url, {
    method: method.toUpperCase(),
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
/** The body as JSON, or as text when it is not: a failure names what came back. */
const bodyOf = async (res: Response): Promise<unknown> => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** Everything a refused call could have changed: row counts, and the states a
 *  skip, a discard or an accept would flip without adding a row. */
async function written() {
  const rows = await countRows(t.db, [
    'sessions',
    'answers',
    'answer_explanations',
    'session_progress',
    'gloss_progress',
    'vocabulary_entries',
    'photo_imports',
    'photo_import_items',
    'discovery_profiles',
    'discovery_runs',
    'discovery_cards',
    'enrollment_grants',
    'targets',
    'target_words',
    'target_events',
  ]);
  const states = await t.db.execute(sql`select
    (select status from sessions where id = ${ids.session}) as session,
    (select status from photo_imports where id = ${ids.photoImport}) as photo_import,
    (select ticked from photo_import_items where import_id = ${ids.photoImport} and position = 0) as item_ticked,
    (select status from discovery_runs where id = ${ids.discoveryRun}) as discovery_run,
    (select answer from discovery_cards where run_id = ${ids.discoveryRun} and position = 0) as discovery_answer,
    (select ticked from discovery_cards where run_id = ${ids.discoveryRun} and position = 1) as discovery_ticked,
    (select level from discovery_profiles where enrollment_id = ${ids.enrollment}) as discovery_level,
    (select my_words_goal from enrollments where id = ${ids.enrollment}) as my_words_goal,
    (select accepted_at::text from enrollment_grants where id = ${ids.grant}) as grant_accepted_at,
    (select ended_at::text from targets where id = ${ids.target}) as target_ended_at,
    (select due_on::text from targets where id = ${ids.target}) as target_due_on`);
  return { rows, ...states.rows[0] };
}

beforeAll(async () => {
  t = await createTestDb();
  ns = mockNamespace('auth-matrix');
  await expectEmails(ns);
  app = createApp(
    createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(29), mailBaseUrl: mailBaseUrlFor(ns) }),
  );
  owner = await signUpWithProfile(app, ns, { email: 'owner@example.com', username: 'matrix_owner' });
  stranger = await signUpWithProfile(app, ns, { email: 'stranger@example.com', username: 'matrix_stranger' });
  tutor = await signUpWithProfile(app, ns, { email: 'tutor@example.com', username: 'matrix_tutor' });
  await setTester(t.db, stranger.userId);
  await setTester(t.db, tutor.userId);

  // The owner's things: through the API where it is cheap, through support helpers otherwise.
  const enrolled = await call('post', '/api/enrollments', owner.cookie, { source_language: 'he', target_language: 'en' });
  expect(enrolled.status).toBe(201);
  const enrollment = ((await enrolled.json()) as { id: string }).id;

  // Two senses of one word, each its own gloss: the owner saves the first; the
  // second is what the stranger and the tutor try to add.
  const word = await insertLexeme(t.db, {
    lemma: LEMMA,
    languageCode: 'en',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'grid' }, { senseCode: 'mould' }],
    variants: [
      {
        form: LEMMA,
        kind: 'word',
        entryRank: 0,
        translations: [
          { senseCode: 'grid', rank: 0, translation: 'מטריצה', exampleSource: null, exampleTarget: null },
          { senseCode: 'mould', rank: 1, translation: 'תבנית', exampleSource: null, exampleTarget: null },
        ],
      },
    ],
  });
  const saved = { gloss_id: word.glossIds[0], variant_id: word.variantIds[0] };
  const unsaved = { gloss_id: word.glossIds[1], variant_id: word.variantIds[0] };
  expect((await call('post', `/api/enrollments/${enrollment}/vocabulary`, owner.cookie, { entries: [saved] })).status).toBe(
    200,
  );

  // The first session is drawn from the seed and is ready at once.
  const made = await call('post', '/api/sessions', owner.cookie, { enrollment_id: enrollment });
  expect(made.status).toBe(201);
  const session = ((await made.json()) as { session_id: string }).session_id;

  // Every photo-import use case authorizes right after loading the import, so
  // one pending row is enough to aim at.
  const photoImport = await seedPhotoImport(t.db, { enrollmentId: enrollment, status: 'read', items: [{ text: LEMMA }] });
  // Phase 69. A profile and an asking run: its first card unanswered, its second one not known
  // and looked up, ticked. Every discovery use case authorizes before it reads a card.
  await seedDiscoveryProfile(t.db, { enrollmentId: enrollment });
  const discoveryRun = await seedDiscoveryRun(t.db, {
    enrollmentId: enrollment,
    status: 'asking',
    cards: [
      { word: LEMMA, answer: null },
      { word: 'grid', answer: 'unknown', options: [{ ...saved, translation: 'מטריצה' }] },
    ],
  });
  // Through the repository, with none of the targets service's rules: it holds the gloss the owner
  // saved, and its date is far enough away that it is active for as long as this file runs.
  const target = await seedTarget(t.db, {
    enrollmentId: enrollment,
    kind: 'exam',
    dueOn: '2099-01-01',
    glossIds: [saved.gloss_id],
  });
  const grant = await seedGrant(t.db, {
    enrollmentId: enrollment,
    ownerUserId: owner.userId,
    granteeUserId: tutor.userId,
    accepted: true,
  });

  ids = { enrollment, session, photoImport, discoveryRun, target, grant, saved, unsaved };
}, 120_000);

afterAll(async () => {
  await clearNamespace(ns);
  await t.close();
});

describe('the fixtures', () => {
  it('name only operations the document publishes', async () => {
    const published = new Set((await operations()).map(key));
    const named = [...OPEN, ...OWN_ONLY, ...Object.keys(STRANGER)];
    expect(named.filter((k) => !published.has(k))).toEqual([]);
  });
});

describe('without a session', () => {
  it('every operation outside sign-in and /health answers 401 not signed in', async () => {
    const closed = (await operations()).filter((op) => !OPEN.has(key(op)));
    expect(closed.length).toBeGreaterThan(20);
    for (const op of closed) {
      const res = await call(op.method, op.path.replace(/\{[^}]+\}/g, 'x'), null, op.method === 'get' ? undefined : {});
      expect([key(op), res.status, await bodyOf(res)]).toEqual([key(op), 401, { error: 'not signed in' }]);
    }
  });
});

describe('a stranger with a profile', () => {
  it('has a fixture for every operation that can address another learner', async () => {
    const missing = (await operations()).map(key).filter((k) => !OPEN.has(k) && !OWN_ONLY.has(k) && !(k in STRANGER));
    expect(missing).toEqual([]);
  });

  it('is refused 403 forbidden on every one of them, and nothing is written', async () => {
    const before = await written();
    for (const [k, aim] of Object.entries(STRANGER)) {
      const { url, body } = aim();
      const res = await call(methodOf(k), url, stranger.cookie, body);
      expect([k, res.status, await bodyOf(res)]).toEqual([k, 403, { error: 'forbidden' }]);
    }
    expect(await written()).toEqual(before);
  });
});

describe('a tutor with an accepted grant', () => {
  it('is refused 403 on everything but saving a word and ending the grant, and nothing is written', async () => {
    const before = await written();
    for (const [k, aim] of Object.entries(STRANGER)) {
      if (TUTOR_ALLOWED.has(k)) continue;
      const { url, body } = aim();
      const res = await call(methodOf(k), url, tutor.cookie, body);
      expect([k, res.status, await bodyOf(res)]).toEqual([k, 403, { error: 'forbidden' }]);
    }
    expect(await written()).toEqual(before);
  });

  it("may save a word to the student's list, credited to the tutor", async () => {
    const save = STRANGER['post /api/enrollments/{id}/vocabulary']();
    const res = await call('post', save.url, tutor.cookie, save.body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved_gloss_ids: [ids.unsaved.gloss_id] });
    const credited = await addedByOf(t.db, ids.enrollment);
    expect(credited.sort()).toEqual([owner.userId, tutor.userId].sort());
  });

  // Last: ending the grant is allowed, and it is what every other check above stood on.
  it('may end the grant, and then may not save a word', async () => {
    const end = STRANGER['delete /api/grants/{id}']();
    expect((await call('delete', end.url, tutor.cookie)).status).toBe(204);
    const save = STRANGER['post /api/enrollments/{id}/vocabulary']();
    const res = await call('post', save.url, tutor.cookie, save.body);
    expect([res.status, await bodyOf(res)]).toEqual([403, { error: 'forbidden' }]);
  });
});
