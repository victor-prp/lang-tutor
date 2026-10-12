import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { QuestionType } from '@lang-tutor/core/domain';
import { Hono } from 'hono';

import { createSessionsRouter } from '../../../src/routes/sessions';
import { ACT_AS, actAs } from '../../support/actAs';
import { createFakeLogger } from '../../support/fakes';
import { clearNamespace, geminiBaseUrlFor, mockNamespace } from '../../support/mockServer';
import { insertListSession, readHintOpened, type AskedGloss } from '../../support/questions';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

/**
 * Phase 38 (spec D4). Whether the learner opened a typed cloze's Hebrew sentence:
 * stored on its first answer, null on every other card and from an older app, and
 * never changed by a retry or a replay. Nothing here calls the model.
 */

let t: TestDb;
const namespaces: string[] = [];

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
});

afterEach(async () => {
  await Promise.all(namespaces.splice(0).map(clearNamespace));
  await t.close();
});

// The learner acting comes from the session in production; here, from ACT_AS.
function postJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [ACT_AS]: 'u_1' },
    body: JSON.stringify(body),
  });
}

function buildTestApp() {
  const ns = mockNamespace('hint');
  namespaces.push(ns);
  const app = new Hono();
  const deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7), geminiBaseUrl: geminiBaseUrlFor(ns) });
  app.use('*', actAs());
  app.route('/api', createSessionsRouter(deps.sessions));
  return app;
}

const WORDS: [string, string][] = [
  ['tome', 'ספר'],
  ['lantern', 'פנס'],
];

/** A ready list session, one card of each type in `types`; a typed card or a
 *  typed cloze accepts `lamp` as another right word. */
async function start(types: QuestionType[]) {
  const asked: AskedGloss[] = [];
  for (const [lemma, translation] of WORDS.slice(0, types.length)) {
    const saved = await seedSavedSenses(t.db, {
      enrollmentId: enrollmentOf('u_1'),
      lemma,
      translations: [translation],
      example: { source: `A sentence with the ${lemma}.`, target: `משפט עם ${translation}.` },
    });
    asked.push({ glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation });
  }
  const session = await insertListSession(t.db, { userId: 'u_1', enrollmentId: enrollmentOf('u_1'), asked, alternatives: ['lamp'], types });
  const app = buildTestApp();
  const next = async (body: object) => {
    const response = await postJson(app, `/api/sessions/${session.sessionId}/next-step`, body);
    expect(response.status).toBe(200);
    return response.json();
  };
  return { ...session, next };
}

describe('hint_opened (phase 38 D4)', () => {
  it('stores it on a first typed cloze answer, true and false as sent', async () => {
    const { sessionId, questions, next } = await start(['cloze_typed', 'cloze_typed']);
    await next({ question_id: questions[0].id, text: 'wrong', hint_opened: true });
    await next({ question_id: questions[1].id, text: '', hint_opened: false });
    expect(await readHintOpened(t.db, sessionId)).toEqual([true, false]);
  });

  it('stores null when an older app sends none', async () => {
    const { sessionId, questions, next } = await start(['cloze_typed']);
    await next({ question_id: questions[0].id, text: 'tome' });
    expect(await readHintOpened(t.db, sessionId)).toEqual([null]);
  });

  it('stores null on a card with no hint, even when sent', async () => {
    const { sessionId, questions, next } = await start(['typed_translation']);
    await next({ question_id: questions[0].id, text: 'tome', hint_opened: true });
    expect(await readHintOpened(t.db, sessionId)).toEqual([null]);
  });

  it('a retry keeps the first answer’s value', async () => {
    const { sessionId, questions, next } = await start(['cloze_typed']);
    expect(await next({ question_id: questions[0].id, text: 'lamp', hint_opened: false })).toMatchObject({
      pending_retry: { answer: 'lamp', wording: 'word' },
    });
    expect(await next({ question_id: questions[0].id, text: 'tome', retry: true, hint_opened: true })).toMatchObject({ complete: true });
    expect(await readHintOpened(t.db, sessionId)).toEqual([false]);
  });

  it('a replay keeps the stored value', async () => {
    const { sessionId, questions, next } = await start(['cloze_typed', 'cloze_typed']);
    const first = await next({ question_id: questions[0].id, text: 'wrong', hint_opened: true });
    expect(await next({ question_id: questions[0].id, text: 'wrong', hint_opened: false })).toEqual(first);
    expect(await readHintOpened(t.db, sessionId)).toEqual([true]);
  });
});
