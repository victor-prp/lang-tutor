import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { NextStepResponseSchema, SessionViewSchema } from '@lang-tutor/core/api/schemas';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';

import type { AppDeps } from '../../../src/composition';
import { createSessionRepo } from '../../../src/repo/sessions';
import { createSessionsRouter } from '../../../src/routes/sessions';
import { ACT_AS, actAs } from '../../support/actAs';
import { createFakeLogger } from '../../support/fakes';
import { CHOSEN_ON, NO_DEVICES } from '../../support/questions';
import {
  STUB_WRONG_HEBREW,
  assertMockServerReachable,
  clearNamespace,
  expectCheck,
  expectContext,
  expectDistractors,
  geminiBaseUrlFor,
  mockNamespace,
} from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';
import { withTx } from '../../support/withTx';

// Phase 39 (spec D6). A pick whose payload carries known meanings is prepared
// through MockServer as a new_meaning card, stored with them, read back on the
// wire, and answered by option index as a multiple choice is.

let t: TestDb;
let deps: AppDeps;
let ns: string;
const EN = enrollmentOf('u_1');

beforeEach(async () => {
  await assertMockServerReachable();
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  ns = mockNamespace(expect.getState().currentTestName ?? 'prepare-session-new-meaning');
  deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7), geminiBaseUrl: geminiBaseUrlFor(ns) });
});

afterEach(async () => {
  await clearNamespace(ns);
  await t.close();
});

// The learner acting comes from the session in production; here, from ACT_AS.
function buildTestApp() {
  const app = new Hono();
  app.use('*', actAs());
  app.route('/api', createSessionsRouter(deps.sessions));
  return app;
}

/** An English word saved with two meanings, each its own gloss, stamped by the
 *  accept job so the prepare job enqueues nothing. */
async function savedTwice(lemma: string, meanings: [string, string]) {
  const word = await seedSavedSenses(t.db, { enrollmentId: EN, lemma, partOfSpeech: 'verb', translations: meanings });
  await t.db.execute(sql`update dict_var_translations set accepted_at = now() where variant_id = ${word.variantId}`);
  // The second meaning is the new one; the first is known.
  return { gloss_id: word.glossIds[1], sense_id: word.senseIds[1], variant_id: word.variantId, known_meanings: [meanings[0]] };
}

const PICK_UP_SENTENCE = "She'll pick up the kids now.";
// Phase 62 (spec D1): six words at most, as a target-language line now keeps.
const RUN_SENTENCE = 'I run the shop with Tom.';

describe('a new_meaning card, prepared, stored and answered', () => {
  it('is prepared from known meanings, read back on the wire, and answered by option index', async () => {
    const pickUp = await savedTwice('pick up', ['להרים', 'לאסוף']);
    const run = await savedTwice('run', ['לרוץ', 'לנהל']);
    await expectDistractors(ns, { tasks: ['meaning', 'meaning'] });
    await expectContext(ns, [
      { key: 'q1', context: PICK_UP_SENTENCE, context_translation: 'היא תאסוף את הילדים עכשיו.', context_word: 'pick up' },
      { key: 'q2', context: RUN_SENTENCE, context_translation: 'אני מנהל את החנות עם תום.', context_word: 'run' },
    ]);
    await expectCheck(ns, { overrides: { q1c: { context_meaning: 'לאסוף' }, q2c: { context_meaning: 'לנהל' } } });
    const sessionId = await withTx(t.db, (tx) => createSessionRepo(tx).insertPreparingSession('u_1', EN, NO_DEVICES, CHOSEN_ON, null));
    await deps.sessions.prepareSession({ session_id: sessionId, picks: [pickUp, run], listening: false, speaking: false });

    // Stored as a new_meaning, with the known meanings its pick carried.
    const stored = await t.db.execute<{ type: string; known_meanings: string[] | null; context: string | null }>(sql`
      select q.type, q.known_meanings, q.context
      from questions q join session_questions sq on sq.question_id = q.id
      where sq.session_id = ${sessionId} order by sq.position`);
    expect(stored.rows).toEqual([
      { type: 'new_meaning', known_meanings: ['להרים'], context: PICK_UP_SENTENCE },
      { type: 'new_meaning', known_meanings: ['לרוץ'], context: RUN_SENTENCE },
    ]);

    const app = buildTestApp();
    const headers = { 'Content-Type': 'application/json', [ACT_AS]: 'u_1' };
    const viewed = await app.request(`/api/sessions/${sessionId}`, { method: 'GET', headers });
    expect(viewed.status).toBe(200);
    const view = SessionViewSchema.parse(await viewed.json());
    expect(view.question).toMatchObject({
      type: 'new_meaning',
      question: 'pick up',
      known_meanings: ['להרים'],
      context: { text: PICK_UP_SENTENCE, mark: { start: 7, end: 14 } },
    });
    const first = view.question as Extract<NonNullable<typeof view.question>, { type: 'new_meaning' }>;
    expect([...first.options].sort()).toEqual(['לאסוף', ...STUB_WRONG_HEBREW].sort());
    expect(first.options[first.correct_option]).toBe('לאסוף');

    // Right, by option index.
    const answered = await app.request(`/api/sessions/${sessionId}/next-step`, {
      method: 'POST', headers, body: JSON.stringify({ question_id: first.id, option_index: first.correct_option }),
    });
    expect(answered.status).toBe(200);
    const next = NextStepResponseSchema.parse(await answered.json());
    if (next.complete) throw new Error('the session ended after one card of two');
    expect(next.question).toMatchObject({ type: 'new_meaning', question: 'run', known_meanings: ['לרוץ'] });
    const second = next.question as typeof first;

    // Wrong, by option index: the session ends, the card missed.
    const wrong = second.options.findIndex((_, index) => index !== second.correct_option);
    const finished = await app.request(`/api/sessions/${sessionId}/next-step`, {
      method: 'POST', headers, body: JSON.stringify({ question_id: second.id, option_index: wrong }),
    });
    expect(finished.status).toBe(200);
    const done = NextStepResponseSchema.parse(await finished.json());
    if (!done.complete) throw new Error('the session did not end after its last card');
    expect(done.score).toEqual({ correct: 1, total: 2 });
    expect(done.missed_questions).toEqual([{ question: expect.objectContaining({ id: second.id, type: 'new_meaning' }), correct_answer: 'לנהל' }]);

    const record = await deps.sessions.getSession('u_1', sessionId);
    expect(record.answers.map((answer) => [answer.question_id, answer.is_correct, answer.answer_string])).toEqual([
      [first.id, true, 'לאסוף'],
      [second.id, false, second.options[wrong]],
    ]);
  });
});
