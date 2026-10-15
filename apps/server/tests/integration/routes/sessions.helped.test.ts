import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { QuestionType } from '@lang-tutor/core/domain';
import { Hono } from 'hono';

import { createSessionsRouter } from '../../../src/routes/sessions';
import { ACT_AS, actAs } from '../../support/actAs';
import { createFakeLogger } from '../../support/fakes';
import { clearNamespace, geminiBaseUrlFor, mockNamespace } from '../../support/mockServer';
import { readGlossMemory } from '../../support/progressRows';
import { insertListSession, readHelped, readStoredAnswers, type AskedGloss } from '../../support/questions';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

/**
 * Phase 55 (spec D6). A letter_tiles or typed_translation answer that carried
 * `helped: true` is stored wrong, with `helped`; the flag is null on every other
 * card, from an older app, and on a retry's second try. Nothing here calls the model.
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
  const ns = mockNamespace('helped');
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
  ['anchor', 'עוגן'],
];

/** A ready list session, one card of each type in `types`; a typed card accepts
 *  `lamp` as another right word. A card's right answer is its word. */
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
  return { ...session, asked, next };
}

const stored = async (sessionId: string) =>
  (await readStoredAnswers(t.db, sessionId)).map((a) => ({ verdict: a.verdict, text: a.answer_string }));

describe('helped (phase 55 D6)', () => {
  it('stores a helped tiles and a helped typed answer as wrong, with helped and the text', async () => {
    const { sessionId, questions, next } = await start(['letter_tiles', 'typed_translation']);
    await next({ question_id: questions[0].id, text: 'tome', helped: true });
    await next({ question_id: questions[1].id, text: 'lantern', helped: true });
    expect(await stored(sessionId)).toEqual([
      { verdict: 'wrong', text: 'tome' },
      { verdict: 'wrong', text: 'lantern' },
    ]);
    expect(await readHelped(t.db, sessionId)).toEqual([true, true]);
  });

  it('stores helped: false as given, and the same text is exact', async () => {
    const { sessionId, questions, next } = await start(['letter_tiles', 'typed_translation']);
    await next({ question_id: questions[0].id, text: 'tome', helped: false });
    await next({ question_id: questions[1].id, text: 'lantern', helped: false });
    expect(await stored(sessionId)).toEqual([
      { verdict: 'exact', text: 'tome' },
      { verdict: 'exact', text: 'lantern' },
    ]);
    expect(await readHelped(t.db, sessionId)).toEqual([false, false]);
  });

  it('stores null when an older app sends none', async () => {
    const { sessionId, questions, next } = await start(['letter_tiles', 'typed_translation']);
    await next({ question_id: questions[0].id, text: 'tome' });
    await next({ question_id: questions[1].id, text: 'lantern' });
    expect(await stored(sessionId)).toEqual([
      { verdict: 'exact', text: 'tome' },
      { verdict: 'exact', text: 'lantern' },
    ]);
    expect(await readHelped(t.db, sessionId)).toEqual([null, null]);
  });

  it('writes written productive Again for each helped answer when the session ends', async () => {
    const { asked, questions, next } = await start(['letter_tiles', 'typed_translation']);
    await next({ question_id: questions[0].id, text: 'tome', helped: true });
    expect(await next({ question_id: questions[1].id, text: 'lantern', helped: true })).toMatchObject({ complete: true });
    for (const word of asked) {
      const productive = (await readGlossMemory(t.db, word.glossId)).find((row) => row.dimension === 'written_productive');
      expect(productive).toMatchObject({ reps: 1, lapses: 1 });
    }
  });

  it('stores null on a card that is neither tiles nor typed, even when sent', async () => {
    const { sessionId, questions, next } = await start(['cloze_typed', 'multiple_choice']);
    // A helped cloze is graded on its text, as ever.
    await next({ question_id: questions[0].id, text: 'tome', helped: true });
    await next({ question_id: questions[1].id, option_index: 0, helped: true });
    expect((await stored(sessionId))[0]).toEqual({ verdict: 'exact', text: 'tome' });
    expect(await readHelped(t.db, sessionId)).toEqual([null, null]);
  });

  it('a retry keeps the first answer’s value, and a helped retry is wrong', async () => {
    const { sessionId, questions, next } = await start(['typed_translation']);
    expect(await next({ question_id: questions[0].id, text: 'lamp', helped: false })).toMatchObject({
      pending_retry: { answer: 'lamp', wording: 'word' },
    });
    expect(await next({ question_id: questions[0].id, text: 'tome', retry: true, helped: true })).toMatchObject({ complete: true });
    expect(await readHelped(t.db, sessionId)).toEqual([false]);
    expect(await readStoredAnswers(t.db, sessionId)).toMatchObject([{ verdict: 'alternative', retry_verdict: 'wrong' }]);
  });

  it('a replay keeps the stored value', async () => {
    const { sessionId, questions, next } = await start(['letter_tiles', 'typed_translation']);
    const first = await next({ question_id: questions[0].id, text: 'tome', helped: true });
    expect(await next({ question_id: questions[0].id, text: 'tome', helped: false })).toEqual(first);
    expect(await readHelped(t.db, sessionId)).toEqual([true]);
  });
});
