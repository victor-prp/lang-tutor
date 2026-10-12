import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { QuestionType } from '@lang-tutor/core/domain';
import { Hono } from 'hono';

import { createSessionsRouter } from '../../../src/routes/sessions';
import { ACT_AS, actAs } from '../../support/actAs';
import { createFakeLogger } from '../../support/fakes';
import { clearNamespace, countGeminiRequests, expectGeminiStatus, expectJudge, geminiBaseUrlFor, mockNamespace } from '../../support/mockServer';
import { insertListSession, readVerdicts, type AskedGloss } from '../../support/questions';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

/**
 * Phase 41 (spec D2). A typed cloze's first answer that the rule calls wrong,
 * sent with check_fit, is shown to the model (MockServer here): a word that fits
 * is stored alternative and holds the card; one that does not, or a failed call,
 * is stored wrong. Without the flag, or for a listed word, nothing is asked.
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

function buildTestApp(ns: string) {
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
  const ns = mockNamespace('fit');
  namespaces.push(ns);
  const app = buildTestApp(ns);
  const next = async (body: object) => {
    const response = await postJson(app, `/api/sessions/${session.sessionId}/next-step`, body);
    expect(response.status).toBe(200);
    return response.json();
  };
  return { ...session, next, ns };
}

describe('check_fit (phase 41 D2)', () => {
  it('stores a word the model says fits as alternative, and holds the card', async () => {
    const { sessionId, questions, next, ns } = await start(['cloze_typed', 'cloze_typed']);
    await expectJudge(ns, 'fits');
    expect(await next({ question_id: questions[0].id, text: 'volume', hint_opened: false, check_fit: true })).toMatchObject({
      pending_retry: { answer: 'volume', wording: 'word' },
    });
    expect(await readVerdicts(t.db, sessionId)).toEqual([{ verdict: 'alternative', retryState: 'pending' }]);
  });

  it('stores a word that does not fit as wrong', async () => {
    const { sessionId, questions, next, ns } = await start(['cloze_typed', 'cloze_typed']);
    await expectJudge(ns, 'wrong');
    expect(await next({ question_id: questions[0].id, text: 'banana', check_fit: true })).toMatchObject({ pending_retry: null });
    expect(await readVerdicts(t.db, sessionId)).toEqual([{ verdict: 'wrong', retryState: null }]);
  });

  it('stores wrong when the call fails', async () => {
    const { sessionId, questions, next, ns } = await start(['cloze_typed', 'cloze_typed']);
    await expectGeminiStatus(ns, 500);
    await next({ question_id: questions[0].id, text: 'volume', check_fit: true });
    expect(await readVerdicts(t.db, sessionId)).toEqual([{ verdict: 'wrong', retryState: null }]);
  });

  it('asks nothing without the flag, or for a listed word', async () => {
    const { sessionId, questions, next, ns } = await start(['cloze_typed', 'cloze_typed']);
    await expectJudge(ns, 'fits');
    await next({ question_id: questions[0].id, text: 'volume' });
    await next({ question_id: questions[1].id, text: 'lamp', check_fit: true });
    expect(await readVerdicts(t.db, sessionId)).toEqual([
      { verdict: 'wrong', retryState: null },
      { verdict: 'alternative', retryState: 'pending' },
    ]);
    expect(await countGeminiRequests(ns)).toBe(0);
  });
});
