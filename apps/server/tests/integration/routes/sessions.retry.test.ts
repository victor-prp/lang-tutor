import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { QuestionType } from '@lang-tutor/core/domain';
import { Hono } from 'hono';

import { JUDGE_MARKER } from '../../../src/domain/judge';
import { TRANSCRIBE_MARKER } from '../../../src/domain/speech';
import { createSessionsRouter } from '../../../src/routes/sessions';
import { ACT_AS, actAs } from '../../support/actAs';
import { createFakeLogger } from '../../support/fakes';
import { clearNamespace, countGeminiRequests, expectJudge, expectTranscription, geminiBaseUrlFor, mockNamespace } from '../../support/mockServer';
import { readSnapshot } from '../../support/progressRows';
import { insertListSession, readStoredAnswers, type AskedGloss } from '../../support/questions';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

/**
 * Phase 34 (spec D9). The second try, on each of the three routes that take a
 * typed or spoken answer: an alternative holds the card open, a network retry of
 * the first answer re-opens it (Review Focus 1), and the last card ends the
 * session, and writes its progress, only when its retry resolves (Review Focus 2).
 */

let t: TestDb;
// Every namespace a test makes, cleared after it: a once-only stub a failing test
// never consumed would otherwise stay on the shared MockServer.
const namespaces: string[] = [];
const namespaceFor = (label: string) => {
  const ns = mockNamespace(label);
  namespaces.push(ns);
  return ns;
};

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

function getJson(app: Hono, path: string) {
  return app.request(path, { method: 'GET', headers: { [ACT_AS]: 'u_1' } });
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

/** A ready list session over saved words, one card of each type in `types`. A
 *  typed or spoken card accepts `lamp` as another right word. */
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
  const session = await insertListSession(t.db, {
    userId: 'u_1',
    enrollmentId: enrollmentOf('u_1'),
    asked,
    alternatives: ['lamp'],
    types,
  });
  return { ...session, glossIds: asked.map((gloss) => gloss.glossId) };
}

/** The dimensions of one gloss that this session raised. */
async function raised(sessionId: string, glossId: string): Promise<string[]> {
  return (await readSnapshot(t.db, sessionId))
    .filter((row) => row.glossId === glossId && row.levelAfter > row.levelBefore)
    .map((row) => row.dimension);
}

describe('the second try on a typed card (next-step)', () => {
  it('holds the card on an alternative, replays it pending, and moves progress for the retry', async () => {
    const app = buildTestApp(namespaceFor('retry-typed'));
    const { sessionId, questions, glossIds } = await start(['typed_translation', 'typed_translation']);
    const next = (body: object) => postJson(app, `/api/sessions/${sessionId}/next-step`, body);

    const first = await next({ question_id: questions[0].id, text: 'lamp' });
    expect(first.status).toBe(200);
    const held = await first.json();
    expect(held).toMatchObject({
      complete: false,
      question: { id: questions[0].id },
      position: { position: 1, total: 2 },
      pending_retry: { answer: 'lamp', wording: 'word' },
    });
    expect(await readStoredAnswers(t.db, sessionId)).toEqual([
      expect.objectContaining({ answer_string: 'lamp', verdict: 'alternative', retry_state: 'pending' }),
    ]);

    // Review Focus 1: a network retry of the first answer re-opens the second try.
    const again = await next({ question_id: questions[0].id, text: 'lamp' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(held);
    // A session left on the card resumes on its second try.
    expect(await (await getJson(app, `/api/sessions/${sessionId}`)).json()).toMatchObject({
      status: 'ready',
      question: { id: questions[0].id },
      position: { position: 1, total: 2 },
      pending_retry: { answer: 'lamp', wording: 'word' },
    });
    // The session holds on the card.
    expect((await next({ question_id: questions[1].id, text: 'lantern' })).status).toBe(409);

    const retried = await next({ question_id: questions[0].id, text: 'tome', retry: true });
    expect(retried.status).toBe(200);
    const moved = await retried.json();
    expect(moved).toMatchObject({ complete: false, question: { id: questions[1].id }, position: { position: 2 }, pending_retry: null });
    // A retry sent again replays, and is not recorded twice.
    expect(await (await next({ question_id: questions[0].id, text: 'tome', retry: true })).json()).toEqual(moved);
    expect(await readStoredAnswers(t.db, sessionId)).toEqual([
      expect.objectContaining({ verdict: 'alternative', retry_state: 'resolved', retry_answer_string: 'tome', retry_verdict: 'exact' }),
    ]);

    const done = await (await next({ question_id: questions[1].id, text: 'lantern' })).json();
    // The score counts the first answer, which was right.
    expect(done).toMatchObject({ complete: true, score: { correct: 2, total: 2 }, missed_questions: [] });
    // Progress counts the retry, as an exact answer.
    expect(await raised(sessionId, glossIds[0])).toEqual(['spelling', 'written_productive', 'written_receptive']);
  });

  // Review Focus 2.
  it("completes the session, and writes progress, only when the last card's retry resolves", async () => {
    const app = buildTestApp(namespaceFor('retry-typed-last'));
    const { sessionId, questions, glossIds } = await start(['typed_translation']);
    const next = (body: object) => postJson(app, `/api/sessions/${sessionId}/next-step`, body);

    expect(await (await next({ question_id: questions[0].id, text: 'lamp' })).json()).toMatchObject({
      complete: false,
      question: { id: questions[0].id },
      pending_retry: { answer: 'lamp' },
    });
    expect(await (await getJson(app, `/api/sessions/${sessionId}`)).json()).toMatchObject({ status: 'ready', progress: [] });
    expect(await readSnapshot(t.db, sessionId)).toEqual([]);

    // Show the answer: an empty text, as on a first answer.
    const gaveUp = await next({ question_id: questions[0].id, text: '', retry: true });
    expect(gaveUp.status).toBe(200);
    expect(await gaveUp.json()).toMatchObject({ complete: true, score: { correct: 1, total: 1 } });
    expect(await readStoredAnswers(t.db, sessionId)).toEqual([expect.objectContaining({ retry_answer_string: '', retry_verdict: 'gave_up' })]);
    // Written once, and a give-up moves nothing.
    expect((await readSnapshot(t.db, sessionId)).length).toBeGreaterThan(0);
    expect(await raised(sessionId, glossIds[0])).toEqual([]);
  });

  it('a skip gives a pending retry up and writes progress once', async () => {
    const app = buildTestApp(namespaceFor('retry-typed-skip'));
    const { sessionId, questions } = await start(['typed_translation', 'typed_translation']);
    await postJson(app, `/api/sessions/${sessionId}/next-step`, { question_id: questions[0].id, text: 'lamp' });

    expect((await postJson(app, `/api/sessions/${sessionId}/skip`, {})).status).toBe(200);
    expect(await readStoredAnswers(t.db, sessionId)).toEqual([
      expect.objectContaining({ retry_state: 'resolved', retry_answer_string: '', retry_verdict: 'gave_up' }),
    ]);
    const written = await readSnapshot(t.db, sessionId);
    expect(written.length).toBeGreaterThan(0);
    expect((await postJson(app, `/api/sessions/${sessionId}/skip`, {})).status).toBe(200);
    expect(await readSnapshot(t.db, sessionId)).toEqual(written);
  });

  it('refuses a retry where nothing is pending', async () => {
    const app = buildTestApp(namespaceFor('retry-typed-none'));
    const { sessionId, questions } = await start(['typed_translation', 'typed_translation']);
    const next = (body: object) => postJson(app, `/api/sessions/${sessionId}/next-step`, body);
    expect((await next({ question_id: questions[0].id, text: 'tome', retry: true })).status).toBe(409);
    expect((await next({ question_id: questions[0].id, text: 'tome' })).status).toBe(200);
    expect((await next({ question_id: questions[0].id, text: 'tome', retry: true })).status).toBe(409);
    expect(await readStoredAnswers(t.db, sessionId)).toEqual([expect.objectContaining({ verdict: 'exact', retry_state: null })]);
  });
});

describe('the second try on a judged card (judged-answer)', () => {
  it('holds the card on another sense, replays it without a call, and judges the retry once', async () => {
    const ns = namespaceFor('retry-judged');
    await expectJudge(ns, 'other_sense');
    await expectJudge(ns, 'right');
    const app = buildTestApp(ns);
    const { sessionId, questions, glossIds } = await start(['typed_meaning', 'typed_meaning']);
    const judged = (body: object) => postJson(app, `/api/sessions/${sessionId}/judged-answer`, body);
    const calls = () => countGeminiRequests(ns, JUDGE_MARKER);

    const first = await judged({ question_id: questions[0].id, text: 'כרך' });
    expect(first.status).toBe(200);
    const held = await first.json();
    expect(held).toMatchObject({
      verdict: 'alternative',
      next: { complete: false, question: { id: questions[0].id }, pending_retry: { answer: 'כרך', wording: 'meaning' } },
    });
    // Review Focus 1: the first answer sent again replays, pending, with no call.
    expect(await (await judged({ question_id: questions[0].id, text: 'כרך' })).json()).toEqual(held);
    expect(await calls()).toBe(1);
    expect((await judged({ question_id: questions[1].id, text: 'פנס' })).status).toBe(409);

    const retried = await (await judged({ question_id: questions[0].id, text: 'עותק', retry: true })).json();
    expect(retried).toMatchObject({ verdict: 'exact', next: { question: { id: questions[1].id }, pending_retry: null } });
    expect(await calls()).toBe(2);
    // The retry of the retry replays, with no third call.
    expect(await (await judged({ question_id: questions[0].id, text: 'עותק', retry: true })).json()).toEqual(retried);
    expect(await calls()).toBe(2);

    // The stored meaning is the rule's: no call.
    expect(await (await judged({ question_id: questions[1].id, text: 'פנס' })).json()).toMatchObject({ next: { complete: true } });
    expect(await calls()).toBe(2);
    expect(await raised(sessionId, glossIds[0])).toEqual(['written_receptive']);
  });

  // Review Focus 2.
  it("completes the session only when the last card's retry resolves, and a give-up costs no call", async () => {
    const ns = namespaceFor('retry-judged-last');
    await expectJudge(ns, 'other_sense');
    const app = buildTestApp(ns);
    const { sessionId, questions, glossIds } = await start(['typed_meaning']);
    const judged = (body: object) => postJson(app, `/api/sessions/${sessionId}/judged-answer`, body);

    expect(await (await judged({ question_id: questions[0].id, text: 'כרך' })).json()).toMatchObject({
      next: { complete: false, question: { id: questions[0].id }, pending_retry: { wording: 'meaning' } },
    });
    expect(await readSnapshot(t.db, sessionId)).toEqual([]);

    const gaveUp = await judged({ question_id: questions[0].id, text: '', retry: true });
    expect(gaveUp.status).toBe(200);
    expect(await gaveUp.json()).toMatchObject({ verdict: 'wrong', next: { complete: true, score: { correct: 1, total: 1 } } });
    expect(await countGeminiRequests(ns, JUDGE_MARKER)).toBe(1);
    expect(await readStoredAnswers(t.db, sessionId)).toEqual([expect.objectContaining({ retry_verdict: 'gave_up' })]);
    expect((await readSnapshot(t.db, sessionId)).length).toBeGreaterThan(0);
    expect(await raised(sessionId, glossIds[0])).toEqual([]);
  });
});

describe('the second try on say the translation (speech)', () => {
  const AUDIO = 'A'.repeat(2_000);

  it('holds the card on another word, replays the clip without a call, and transcribes the retry once', async () => {
    const ns = namespaceFor('retry-speech');
    await expectTranscription(ns, 'lamp', { once: true });
    await expectTranscription(ns, 'the tome', { once: true });
    const app = buildTestApp(ns);
    const { sessionId, questions } = await start(['say_translation', 'say_translation']);
    const speak = (body: object) =>
      postJson(app, `/api/sessions/${sessionId}/speech`, { question_id: questions[0].id, mime_type: 'audio/aac', audio: AUDIO, ...body });
    const calls = () => countGeminiRequests(ns, TRANSCRIBE_MARKER);

    const first = await speak({});
    expect(first.status).toBe(200);
    const held = await first.json();
    expect(held).toMatchObject({
      heard: 'lamp',
      verdict: 'alternative',
      next: { complete: false, question: { id: questions[0].id }, pending_retry: { answer: 'lamp', wording: 'word' } },
    });
    // Review Focus 1: the first clip sent again replays, pending, with no call.
    expect(await (await speak({})).json()).toEqual(held);
    expect(await calls()).toBe(1);
    expect((await speak({ question_id: questions[1].id })).status).toBe(409);

    const retried = await (await speak({ retry: true })).json();
    expect(retried).toMatchObject({ heard: 'the tome', verdict: 'understood', next: { question: { id: questions[1].id }, pending_retry: null } });
    expect(await calls()).toBe(2);
    expect(await (await speak({ retry: true })).json()).toEqual(retried);
    expect(await calls()).toBe(2);
    expect(await readStoredAnswers(t.db, sessionId)).toEqual([
      expect.objectContaining({ answer_string: 'lamp', retry_state: 'resolved', retry_answer_string: 'the tome', retry_verdict: 'understood' }),
    ]);
  });

  // Review Focus 2.
  it("completes the session only when the last card's retry resolves, here by show the answer", async () => {
    const ns = namespaceFor('retry-speech-last');
    await expectTranscription(ns, 'lamp', { once: true });
    const app = buildTestApp(ns);
    const { sessionId, questions } = await start(['say_translation']);

    const held = await (
      await postJson(app, `/api/sessions/${sessionId}/speech`, { question_id: questions[0].id, mime_type: 'audio/aac', audio: AUDIO })
    ).json();
    expect(held).toMatchObject({ verdict: 'alternative', next: { complete: false, pending_retry: { answer: 'lamp' } } });
    expect(await readSnapshot(t.db, sessionId)).toEqual([]);

    const shown = await postJson(app, `/api/sessions/${sessionId}/next-step`, { question_id: questions[0].id, pass: 'show_answer', retry: true });
    expect(shown.status).toBe(200);
    expect(await shown.json()).toMatchObject({ complete: true, score: { correct: 1, total: 1 } });
    expect(await readStoredAnswers(t.db, sessionId)).toEqual([expect.objectContaining({ retry_answer_string: '', retry_verdict: 'gave_up' })]);
    expect((await readSnapshot(t.db, sessionId)).length).toBeGreaterThan(0);
  });

  it('records nothing for a retry that was not understood', async () => {
    const ns = namespaceFor('retry-speech-unheard');
    await expectTranscription(ns, 'lamp', { once: true });
    await expectTranscription(ns, 'kettle', { once: true });
    const app = buildTestApp(ns);
    const { sessionId, questions } = await start(['say_translation', 'say_translation']);
    const speak = (body: object) =>
      postJson(app, `/api/sessions/${sessionId}/speech`, { question_id: questions[0].id, mime_type: 'audio/aac', audio: AUDIO, ...body });

    await speak({});
    expect(await (await speak({ retry: true })).json()).toEqual({ heard: 'kettle', verdict: 'unheard' });
    expect(await readStoredAnswers(t.db, sessionId)).toEqual([expect.objectContaining({ retry_state: 'pending' })]);
  });
});
