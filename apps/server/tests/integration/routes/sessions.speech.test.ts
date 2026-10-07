import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import { createFakeLogger } from '../../support/fakes';
import {
  clearNamespace,
  expectGeminiStatus,
  expectTranscription,
  geminiBaseUrlFor,
  mockNamespace,
} from '../../support/mockServer';
import { insertListSession, readStoredAnswers, type AskedSense } from '../../support/questions';
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

/** A ready list session: read aloud, say the translation, today's card. */
async function startSpeaking() {
  const asked: AskedSense[] = [];
  for (const [lemma, translation] of [
    ['tome', 'ספר'],
    ['lantern', 'פנס'],
    ['quill', 'נוצה'],
  ]) {
    const saved = await seedSavedSenses(t.db, { enrollmentId: enrollmentOf('u_1'), lemma, translations: [translation] });
    asked.push({ senseId: saved.senseIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation });
  }
  return insertListSession(t.db, {
    userId: 'u_1',
    enrollmentId: enrollmentOf('u_1'),
    asked,
    alternatives: ['lamp'],
    types: ['read_aloud', 'say_translation', 'multiple_choice'],
  });
}

const AUDIO = 'A'.repeat(2_000);

describe('POST /api/sessions/:id/speech', () => {
  it('records an understood attempt and carries the next step; an unheard one records nothing', async () => {
    const ns = mockNamespace('speech-understood');
    await expectTranscription(ns, 'tomb', { once: true });
    await expectTranscription(ns, 'the tome', { once: true });
    const app = buildTestApp(ns);
    const { sessionId, questions } = await startSpeaking();
    const speak = () =>
      postJson(app, `/api/sessions/${sessionId}/speech`, { user_id: 'u_1', question_id: questions[0].id, mime_type: 'audio/aac', audio: AUDIO });

    const missed = await speak();
    expect(missed.status).toBe(200);
    expect(await missed.json()).toEqual({ heard: 'tomb', verdict: 'unheard' });

    const heard = await speak();
    const body = await heard.json();
    expect(body).toMatchObject({ heard: 'the tome', verdict: 'understood', next: { complete: false, question: { type: 'say_translation' } } });
  });

  it('answers say the translation with an alternative, then completes with a skip left out of the score', async () => {
    const ns = mockNamespace('speech-score');
    await expectTranscription(ns, 'lamp');
    const app = buildTestApp(ns);
    const { sessionId, questions } = await startSpeaking();
    expect((await postJson(app, `/api/sessions/${sessionId}/next-step`, { user_id: 'u_1', question_id: questions[0].id, pass: 'skip' })).status).toBe(200);
    const said = await (
      await postJson(app, `/api/sessions/${sessionId}/speech`, { user_id: 'u_1', question_id: questions[1].id, mime_type: 'audio/aac', audio: AUDIO })
    ).json();
    expect(said).toMatchObject({ verdict: 'alternative' });
    const done = await (
      await postJson(app, `/api/sessions/${sessionId}/next-step`, { user_id: 'u_1', question_id: questions[2].id, option_index: 0 })
    ).json();
    expect(done.score.total).toBe(2);
    expect(done.missed_questions.map((m: { question: { id: string } }) => m.question.id)).not.toContain(questions[0].id);
  });

  it('stores a long transcript truncated to 100 characters', async () => {
    const ns = mockNamespace('speech-long');
    await expectTranscription(ns, `tome ${'a'.repeat(150)}`);
    const app = buildTestApp(ns);
    const { sessionId, questions } = await startSpeaking();
    const res = await postJson(app, `/api/sessions/${sessionId}/speech`, { user_id: 'u_1', question_id: questions[0].id, mime_type: 'audio/aac', audio: AUDIO });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.heard).toHaveLength(100);
    expect(body).toMatchObject({ verdict: 'understood', next: { complete: false } });
    const stored = await readStoredAnswers(t.db, sessionId);
    expect(stored[0].answer_string).toHaveLength(100);
    expect(stored[0].verdict).toBe('understood');
  });

  it('400s a choice card, 404s another learner, 409s a card that is not current, and 502s a failing model', async () => {
    const ns = mockNamespace('speech-errors');
    const app = buildTestApp(ns);
    const { sessionId, questions } = await startSpeaking();
    const at = (question_id: string, user_id = 'u_1') =>
      postJson(app, `/api/sessions/${sessionId}/speech`, { user_id, question_id, mime_type: 'audio/aac', audio: AUDIO });
    expect((await at(questions[0].id, 'u_2')).status).toBe(404);
    expect((await at(questions[1].id)).status).toBe(409);
    await expectGeminiStatus(ns, 503);
    expect((await at(questions[0].id)).status).toBe(502);
    expect((await postJson(app, `/api/sessions/${sessionId}/next-step`, { user_id: 'u_1', question_id: questions[0].id, pass: 'skip' })).status).toBe(200);
    await clearNamespace(ns);
    await expectTranscription(ns, 'lantern');
    expect((await postJson(app, `/api/sessions/${sessionId}/next-step`, { user_id: 'u_1', question_id: questions[1].id, text: 'lantern' })).status).toBe(200);
    expect((await at(questions[2].id)).status).toBe(400);
  });

  it('413s a body over 300 KB', async () => {
    const app = buildTestApp(mockNamespace('speech-large'));
    const { sessionId, questions } = await startSpeaking();
    const res = await app.request(`/api/sessions/${sessionId}/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(400 * 1024) },
      body: JSON.stringify({ user_id: 'u_1', question_id: questions[0].id, mime_type: 'audio/aac', audio: 'A'.repeat(400 * 1024) }),
    });
    expect(res.status).toBe(413);
  });
});
