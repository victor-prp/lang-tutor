import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createApp } from '../../../src/app';
import { signUpWithProfile } from '../../support/auth';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger } from '../../support/fakes';
import { addedByOf, seedGrant } from '../../support/grantRows';
import { expectEmails, mailBaseUrlFor, mockNamespace } from '../../support/mockServer';
import { seedPhotoImport } from '../../support/photoImportRows';
import { countRows } from '../../support/rowCounts';
import { createTestServerDeps } from '../../support/serverDeps';
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
let app: ReturnType<typeof createApp>;
let owner: Account;
let stranger: Account;
let tutor: Account;
// The owner's things, filled in beforeAll.
let ids: {
  enrollment: string;
  session: string;
  photoImport: string;
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
  'get /api/enrollments/{id}/sessions/current': () => ({ url: `/api/enrollments/${ids.enrollment}/sessions/current` }),
  'get /api/enrollments/{id}/vocabulary': () => ({ url: `/api/enrollments/${ids.enrollment}/vocabulary` }),
  'post /api/enrollments/{id}/vocabulary': () => ({
    url: `/api/enrollments/${ids.enrollment}/vocabulary`,
    body: { entries: [ids.unsaved] },
  }),
  'delete /api/enrollments/{id}/vocabulary/glosses/{gloss_id}': () => ({
    url: `/api/enrollments/${ids.enrollment}/vocabulary/glosses/${ids.saved.gloss_id}`,
  }),
  'get /api/enrollments/{id}/vocabulary/word': () => ({
    url: `/api/enrollments/${ids.enrollment}/vocabulary/word?lemma=${LEMMA}`,
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
  'post /api/photo-imports/{id}/discard': () => ({ url: `/api/photo-imports/${ids.photoImport}/discard` }),
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
    'session_progress',
    'gloss_progress',
    'vocabulary_entries',
    'photo_imports',
    'photo_import_items',
    'enrollment_grants',
  ]);
  const states = await t.db.execute(sql`select
    (select status from sessions where id = ${ids.session}) as session,
    (select status from photo_imports where id = ${ids.photoImport}) as photo_import,
    (select ticked from photo_import_items where import_id = ${ids.photoImport} and position = 0) as item_ticked,
    (select accepted_at::text from enrollment_grants where id = ${ids.grant}) as grant_accepted_at`);
  return { rows, ...states.rows[0] };
}

beforeAll(async () => {
  t = await createTestDb();
  const ns = mockNamespace('auth-matrix');
  await expectEmails(ns);
  app = createApp(
    createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(29), mailBaseUrl: mailBaseUrlFor(ns) }),
  );
  owner = await signUpWithProfile(app, ns, { email: 'owner@example.com', username: 'matrix_owner' });
  stranger = await signUpWithProfile(app, ns, { email: 'stranger@example.com', username: 'matrix_stranger' });
  tutor = await signUpWithProfile(app, ns, { email: 'tutor@example.com', username: 'matrix_tutor' });

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
  const grant = await seedGrant(t.db, {
    enrollmentId: enrollment,
    ownerUserId: owner.userId,
    granteeUserId: tutor.userId,
    accepted: true,
  });

  ids = { enrollment, session, photoImport, grant, saved, unsaved };
}, 120_000);

afterAll(async () => {
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
