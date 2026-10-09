import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import { createFakeLogger } from '../../support/fakes';
import { clearNamespace, expectGeminiStatus, expectJudge, geminiBaseUrlFor, mockNamespace } from '../../support/mockServer';
import { insertListSession, readStoredAnswers, type AskedGloss } from '../../support/questions';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';
import { createSessionsRouter } from '../../../src/routes/sessions';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  await seedUser(t.db, 'u_2');
});

afterEach(async () => {
  await t.close();
});

function postJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function buildTestApp(ns: string) {
  const app = new Hono();
  const deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7), geminiBaseUrl: geminiBaseUrlFor(ns) });
  app.route('/api', createSessionsRouter(deps.sessions));
  return app;
}

/** A ready list session: a meaning card for "tome" (ספר), then a choice card. */
async function startMeaning() {
  const asked: AskedGloss[] = [];
  for (const [lemma, translation] of [
    ['tome', 'ספר'],
    ['lantern', 'פנס'],
  ]) {
    const saved = await seedSavedSenses(t.db, {
      enrollmentId: enrollmentOf('u_1'),
      lemma,
      translations: [translation],
      example: { source: `A sentence with the ${lemma}.`, target: `משפט עם ${translation}.` },
    });
    asked.push({ glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation });
  }
  return insertListSession(t.db, {
    userId: 'u_1',
    enrollmentId: enrollmentOf('u_1'),
    asked,
    types: ['typed_meaning', 'multiple_choice'],
  });
}

describe('POST /api/sessions/:id/judged-answer', () => {
  it('rules the stored meaning exact, with points, without a model call', async () => {
    const app = buildTestApp(mockNamespace('judged-rule'));
    const { sessionId, questions } = await startMeaning();
    const res = await postJson(app, `/api/sessions/${sessionId}/judged-answer`, { user_id: 'u_1', question_id: questions[0].id, text: 'סֵפֶר.' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ verdict: 'exact', next: { complete: false } });
    const stored = await readStoredAnswers(t.db, sessionId);
    expect(stored).toHaveLength(1);
    expect(stored[0].verdict).toBe('exact');
  });

  it('asks the judge for a synonym, then replays the same request without a second record', async () => {
    const ns = mockNamespace('judged-model');
    await expectJudge(ns, 'right');
    const app = buildTestApp(ns);
    const { sessionId, questions } = await startMeaning();
    const send = () => postJson(app, `/api/sessions/${sessionId}/judged-answer`, { user_id: 'u_1', question_id: questions[0].id, text: 'כרך' });
    const first = await send();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ verdict: 'exact', next: { question: { id: questions[1].id } } });
    const again = await send();
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ verdict: 'exact' });
    expect(await readStoredAnswers(t.db, sessionId)).toHaveLength(1);
  });

  it('502s a failing judge and records nothing; the same answer then succeeds', async () => {
    const ns = mockNamespace('judged-failure');
    const app = buildTestApp(ns);
    const { sessionId, questions } = await startMeaning();
    const send = () => postJson(app, `/api/sessions/${sessionId}/judged-answer`, { user_id: 'u_1', question_id: questions[0].id, text: 'כרך' });
    await expectGeminiStatus(ns, 500);
    expect((await send()).status).toBe(502);
    expect(await readStoredAnswers(t.db, sessionId)).toHaveLength(0);
    await clearNamespace(ns);
    await expectJudge(ns, 'wrong');
    const retried = await send();
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ verdict: 'wrong' });
  });

  it('404s another learner, 409s a card that is not current, 400s a card that is not judged', async () => {
    const app = buildTestApp(mockNamespace('judged-errors'));
    const { sessionId, questions } = await startMeaning();
    const at = (question_id: string, user_id = 'u_1') =>
      postJson(app, `/api/sessions/${sessionId}/judged-answer`, { user_id, question_id, text: 'ספר' });
    expect((await at(questions[0].id, 'u_2')).status).toBe(404);
    expect((await at(questions[1].id)).status).toBe(409);
    expect((await at(questions[0].id)).status).toBe(200);
    expect((await at(questions[1].id)).status).toBe(400);
  });

  it('refuses a next-step text for a meaning card, and records nothing', async () => {
    const app = buildTestApp(mockNamespace('judged-next-step'));
    const { sessionId, questions } = await startMeaning();
    const res = await postJson(app, `/api/sessions/${sessionId}/next-step`, { user_id: 'u_1', question_id: questions[0].id, text: 'ספר' });
    expect(res.status).toBe(400);
    expect(await readStoredAnswers(t.db, sessionId)).toHaveLength(0);
  });

  it('400s a text over 300 characters', async () => {
    const app = buildTestApp(mockNamespace('judged-long'));
    const { sessionId, questions } = await startMeaning();
    const res = await postJson(app, `/api/sessions/${sessionId}/judged-answer`, { user_id: 'u_1', question_id: questions[0].id, text: 'א'.repeat(301) });
    expect(res.status).toBe(400);
  });
});
