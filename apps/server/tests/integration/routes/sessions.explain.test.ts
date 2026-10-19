import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { QuestionType } from '@lang-tutor/core/domain';
import { Hono } from 'hono';

import { EXPLAIN_MARKER } from '../../../src/domain/explain';
import { createSessionsRouter } from '../../../src/routes/sessions';
import { ACT_AS, actAs } from '../../support/actAs';
import { createFakeLogger } from '../../support/fakes';
import { clearNamespace, countGeminiRequests, expectExplain, expectJudge, geminiBaseUrlFor, mockNamespace } from '../../support/mockServer';
import { insertListSession, readExplanations, type AskedGloss } from '../../support/questions';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

/**
 * Phase 66 (spec D2). POST /api/sessions/:id/explain: the mistakes in a
 * translation card's recorded answer, called for once and stored, and refused
 * where there is no final text to explain.
 */

let t: TestDb;
const namespaces: string[] = [];
const namespaceFor = (label: string) => {
  const ns = mockNamespace(label);
  namespaces.push(ns);
  return ns;
};

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  await seedUser(t.db, 'u_2');
});

afterEach(async () => {
  await Promise.all(namespaces.splice(0).map(clearNamespace));
  await t.close();
});

function post(app: Hono, path: string, body: unknown, user = 'u_1') {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [ACT_AS]: user },
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

/** A ready list session over saved words, one card of each type in `types`. The
 *  translation card's reference is 'We use tome here today.' */
async function start(types: QuestionType[]) {
  const asked: AskedGloss[] = [];
  for (const [lemma, translation] of WORDS.slice(0, types.length)) {
    const saved = await seedSavedSenses(t.db, { enrollmentId: enrollmentOf('u_1'), lemma, translations: [translation] });
    asked.push({ glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation });
  }
  return insertListSession(t.db, { userId: 'u_1', enrollmentId: enrollmentOf('u_1'), asked, alternatives: [], types });
}

const EXPLAINED = {
  corrected: 'We use the tome here today.',
  mistakes: [{ wrong: '', right: 'the', why: 'חסרה מילית היידוע' }],
};

const storedExplanations = (sessionId: string) => readExplanations(t.db, sessionId);

describe('POST /api/sessions/:id/explain', () => {
  it('explains a mistaken answer once, stores it, and answers again without a call', async () => {
    const ns = namespaceFor('explain-model');
    const app = buildTestApp(ns);
    const { sessionId, questions } = await start(['sentence_translation']);
    await expectJudge(ns, 'right');
    expect((await post(app, `/api/sessions/${sessionId}/judged-answer`, { question_id: questions[0].id, text: 'We use tome here today please.' })).status).toBe(200);
    await expectExplain(ns, EXPLAINED);

    const first = await post(app, `/api/sessions/${sessionId}/explain`, { question_id: questions[0].id });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(EXPLAINED);
    expect(await storedExplanations(sessionId)).toEqual([{ position: 0, text: 'We use tome here today please.', ...EXPLAINED }]);

    const again = await post(app, `/api/sessions/${sessionId}/explain`, { question_id: questions[0].id });
    expect(await again.json()).toEqual(EXPLAINED);
    expect(await countGeminiRequests(ns, EXPLAIN_MARKER)).toBe(1);
  });

  it('answers the reference as typed with no mistakes, without a call or a row', async () => {
    const ns = namespaceFor('explain-rule');
    const app = buildTestApp(ns);
    const { sessionId, questions } = await start(['sentence_translation']);
    await post(app, `/api/sessions/${sessionId}/judged-answer`, { question_id: questions[0].id, text: 'we use tome here today' });

    const response = await post(app, `/api/sessions/${sessionId}/explain`, { question_id: questions[0].id });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ corrected: 'we use tome here today', mistakes: [] });
    expect(await countGeminiRequests(ns, EXPLAIN_MARKER)).toBe(0);
    expect(await storedExplanations(sessionId)).toEqual([]);
  });

  it("refuses a pending second try with 409, then explains the second try's text", async () => {
    const ns = namespaceFor('explain-retry');
    const app = buildTestApp(ns);
    const { sessionId, questions } = await start(['sentence_translation']);
    await expectJudge(ns, 'other_word');
    await post(app, `/api/sessions/${sessionId}/judged-answer`, { question_id: questions[0].id, text: 'We use book here today.' });

    expect((await post(app, `/api/sessions/${sessionId}/explain`, { question_id: questions[0].id })).status).toBe(409);
    expect(await countGeminiRequests(ns, EXPLAIN_MARKER)).toBe(0);

    await expectJudge(ns, 'right');
    await post(app, `/api/sessions/${sessionId}/judged-answer`, { question_id: questions[0].id, text: 'We use tome here now.', retry: true });
    await expectExplain(ns, EXPLAINED);
    expect((await post(app, `/api/sessions/${sessionId}/explain`, { question_id: questions[0].id })).status).toBe(200);
    expect(await storedExplanations(sessionId)).toEqual([expect.objectContaining({ text: 'We use tome here now.' })]);
  });

  it('400s another card type and a card not answered yet, 403s another learner, 404s no session', async () => {
    const ns = namespaceFor('explain-refused');
    const app = buildTestApp(ns);
    const { sessionId, questions } = await start(['typed_translation', 'sentence_translation']);
    await post(app, `/api/sessions/${sessionId}/next-step`, { question_id: questions[0].id, text: 'tome' });

    expect((await post(app, `/api/sessions/${sessionId}/explain`, { question_id: questions[0].id })).status).toBe(400);
    expect((await post(app, `/api/sessions/${sessionId}/explain`, { question_id: questions[1].id })).status).toBe(400);
    expect((await post(app, `/api/sessions/${sessionId}/explain`, { question_id: questions[1].id }, 'u_2')).status).toBe(403);
    expect((await post(app, '/api/sessions/00000000-0000-0000-0000-000000000000/explain', { question_id: questions[1].id })).status).toBe(404);
    expect(await countGeminiRequests(ns, EXPLAIN_MARKER)).toBe(0);
  });

  it('502s a failed call and stores nothing; asked again, it succeeds', async () => {
    const ns = namespaceFor('explain-failed');
    const app = buildTestApp(ns);
    const { sessionId, questions } = await start(['sentence_translation']);
    await expectJudge(ns, 'right');
    await post(app, `/api/sessions/${sessionId}/judged-answer`, { question_id: questions[0].id, text: 'We use tome here today please.' });
    await expectExplain(ns, EXPLAINED, { status: 500 });

    expect((await post(app, `/api/sessions/${sessionId}/explain`, { question_id: questions[0].id })).status).toBe(502);
    expect(await storedExplanations(sessionId)).toEqual([]);

    await expectExplain(ns, EXPLAINED);
    expect((await post(app, `/api/sessions/${sessionId}/explain`, { question_id: questions[0].id })).status).toBe(200);
  });
});
