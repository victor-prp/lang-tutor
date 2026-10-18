import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { QuestionType } from '@lang-tutor/core/domain';
import { Hono } from 'hono';

import { createSessionsRouter } from '../../../src/routes/sessions';
import { ACT_AS, actAs } from '../../support/actAs';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { clearNamespace, expectJudge, expectTranscription, geminiBaseUrlFor, mockNamespace } from '../../support/mockServer';
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
 * card, from an older app, and on a retry's second try. Phase 56 (spec D2–D4):
 * so is an answer to the five other cards that take help, through next-step, the
 * judge and speech; a spoken one is stored given up. Only those call the model,
 * through the namespace's stubs.
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

function buildTestApp(ns: string, logger: FakeLogger) {
  const app = new Hono();
  const deps = createTestServerDeps({ db: t.db, logger, rng: testRng(7), geminiBaseUrl: geminiBaseUrlFor(ns) });
  app.use('*', actAs());
  app.route('/api', createSessionsRouter(deps.sessions));
  return app;
}

const WORDS: [string, string][] = [
  ['tome', 'ספר'],
  ['lantern', 'פנס'],
  ['anchor', 'עוגן'],
  ['harbor', 'נמל'],
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
  const ns = mockNamespace('helped');
  namespaces.push(ns);
  const logger = createFakeLogger();
  const app = buildTestApp(ns, logger);
  const post = async (route: 'next-step' | 'judged-answer' | 'speech', body: object) => {
    const response = await postJson(app, `/api/sessions/${session.sessionId}/${route}`, body);
    expect(response.status).toBe(200);
    return response.json();
  };
  const next = (body: object) => post('next-step', body);
  return { ...session, asked, ns, logger, post, next };
}

const AUDIO = 'A'.repeat(2_000);

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

  it('stores null on a choice when an older app sends none', async () => {
    const { sessionId, questions, next } = await start(['multiple_choice']);
    // Phase 63 (spec D10): a choice takes help now; a new meaning, which does not,
    // is covered by core's takesHelp table, which is what the server stores by.
    await next({ question_id: questions[0].id, option_index: 0 });
    expect(await readHelped(t.db, sessionId)).toEqual([null]);
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

describe('help on more cards (phase 56 D2–D4)', () => {
  it('stores a helped dictation, typed cloze and typed say-the-translation answer wrong, with helped', async () => {
    const { sessionId, questions, next } = await start(['dictation', 'cloze_typed', 'say_translation']);
    await next({ question_id: questions[0].id, text: 'tome', helped: true });
    await next({ question_id: questions[1].id, text: 'lantern', helped: true, hint_opened: false });
    await next({ question_id: questions[2].id, text: 'anchor', helped: true });
    expect(await stored(sessionId)).toEqual([
      { verdict: 'wrong', text: 'tome' },
      { verdict: 'wrong', text: 'lantern' },
      { verdict: 'wrong', text: 'anchor' },
    ]);
    expect(await readHelped(t.db, sessionId)).toEqual([true, true, true]);
  });

  it('makes no fit check for a helped gap word the rule calls wrong', async () => {
    const { sessionId, questions, next, logger } = await start(['cloze_typed']);
    // No fit stub in the namespace: a call would log a failed check.
    await next({ question_id: questions[0].id, text: 'candle', helped: true, check_fit: true, hint_opened: false });
    expect(logger.events.filter((event) => /^answer_fit_check/.test(String(event.event)))).toEqual([]);
    expect(await stored(sessionId)).toEqual([{ verdict: 'wrong', text: 'candle' }]);
    expect(await readHelped(t.db, sessionId)).toEqual([true]);
  });

  it('stores a helped typed meaning and a helped translation wrong, and answers with the judge’s verdict', async () => {
    const { sessionId, questions, ns, post, logger } = await start(['typed_meaning', 'sentence_translation']);
    // The stored meaning, by rule; then a wording the model rules right.
    expect(await post('judged-answer', { question_id: questions[0].id, text: 'ספר', helped: true })).toMatchObject({ verdict: 'exact' });
    await expectJudge(ns, 'right');
    expect(await post('judged-answer', { question_id: questions[1].id, text: 'We use a lantern here today.', helped: true })).toMatchObject({
      verdict: 'exact',
      next: { complete: true },
    });
    expect(await stored(sessionId)).toEqual([
      { verdict: 'wrong', text: 'ספר' },
      { verdict: 'wrong', text: 'We use a lantern here today.' },
    ]);
    expect(await readHelped(t.db, sessionId)).toEqual([true, true]);
    expect(logger.events.filter((event) => event.event === 'answer_judged').map((event) => event.helped)).toEqual([true, true]);
  });

  it('stores a helped spoken answer given up with its transcript, replays it understood, and lapses spoken production', async () => {
    const { sessionId, questions, asked, ns, post, logger } = await start(['say_translation']);
    await expectTranscription(ns, 'tome');
    const body = { question_id: questions[0].id, mime_type: 'audio/aac', audio: AUDIO, helped: true };
    const first = await post('speech', body);
    expect(first).toMatchObject({ heard: 'tome', verdict: 'understood', next: { complete: true } });
    expect(await readStoredAnswers(t.db, sessionId)).toMatchObject([{ verdict: 'gave_up', answer_string: 'tome', is_correct: false }]);
    expect(await readHelped(t.db, sessionId)).toEqual([true]);
    expect(logger.events.find((event) => event.event === 'speech_judged')).toMatchObject({ helped: true });
    // The same clip again, as a lost response is re-sent: the stored answer, no second record.
    expect(await post('speech', body)).toMatchObject({ heard: 'tome', verdict: 'understood', next: { complete: true } });
    expect(await readStoredAnswers(t.db, sessionId)).toHaveLength(1);
    const spoken = (await readGlossMemory(t.db, asked[0].glossId)).find((row) => row.dimension === 'spoken_productive');
    expect(spoken).toMatchObject({ reps: 1, lapses: 1 });
  });

  // Final review. Given up after help: a give-up as ever, and the help recorded.
  it('records a spoken give-up after help as given up, with helped', async () => {
    const { sessionId, questions, next } = await start(['say_translation']);
    await next({ question_id: questions[0].id, pass: 'show_answer', helped: true });
    expect(await readStoredAnswers(t.db, sessionId)).toMatchObject([{ verdict: 'gave_up', answer_string: '', is_correct: false }]);
    expect(await readHelped(t.db, sessionId)).toEqual([true]);
  });

  it('records a spoken answer sent without help as understood, with helped false', async () => {
    const { sessionId, questions, ns, post } = await start(['say_translation']);
    await expectTranscription(ns, 'tome');
    await post('speech', { question_id: questions[0].id, mime_type: 'audio/aac', audio: AUDIO, helped: false });
    expect(await readStoredAnswers(t.db, sessionId)).toMatchObject([{ verdict: 'understood', is_correct: true }]);
    expect(await readHelped(t.db, sessionId)).toEqual([false]);
  });
});

// Phase 63 (spec D10, D11). A choice or a board word answered after help is
// stored with `helped`, read back wrong, and graded as a wrong option is.
describe('help on choices (phase 63 D10–D11)', () => {
  const rightOf = (question: { correct_option?: number }) => question.correct_option!;
  // The dimension a wrong option on each card grades Again (core gradesFor).
  const AGAIN_ON: [QuestionType, string][] = [
    ['multiple_choice', 'written_receptive'],
    ['reverse_choice', 'written_productive'],
    ['listen_choice', 'spoken_receptive'],
    ['cloze_choice', 'written_productive'],
  ];

  it('stores a helped right option on each choice card wrong, with helped, and grades it Again', async () => {
    const { sessionId, asked, questions, next } = await start(AGAIN_ON.map(([type]) => type));
    let last: unknown;
    for (const question of questions) {
      last = await next({ question_id: question.id, option_index: rightOf(question as { correct_option?: number }), helped: true });
    }
    expect(last).toMatchObject({ complete: true });
    expect(await readHelped(t.db, sessionId)).toEqual([true, true, true, true]);
    expect((await readStoredAnswers(t.db, sessionId)).map((a) => a.is_correct)).toEqual([false, false, false, false]);
    for (const [index, [, dimension]] of AGAIN_ON.entries()) {
      const row = (await readGlossMemory(t.db, asked[index].glossId)).find((r) => r.dimension === dimension);
      expect([AGAIN_ON[index][0], row]).toEqual([AGAIN_ON[index][0], expect.objectContaining({ reps: 1, lapses: 1 })]);
    }
  });

  it('stores an unhelped right option right, with helped false', async () => {
    const { sessionId, questions, next } = await start(['multiple_choice', 'listen_choice']);
    for (const question of questions) {
      await next({ question_id: question.id, option_index: rightOf(question as { correct_option?: number }), helped: false });
    }
    expect(await readHelped(t.db, sessionId)).toEqual([false, false]);
    expect((await readStoredAnswers(t.db, sessionId)).map((a) => a.is_correct)).toEqual([true, true]);
  });

  it('stores a helped board word helped, and its evidence wrong while the other word stays right', async () => {
    const { sessionId, asked, questions, next } = await start(['matching', 'matching']);
    await next({ question_id: questions[0].id, option_index: rightOf(questions[0] as { correct_option?: number }), helped: true });
    expect(await next({ question_id: questions[1].id, option_index: rightOf(questions[1] as { correct_option?: number }), helped: false })).toMatchObject({
      complete: true,
    });
    expect(await readHelped(t.db, sessionId)).toEqual([true, false]);
    const helped = (await readGlossMemory(t.db, asked[0].glossId)).find((r) => r.dimension === 'written_receptive');
    const plain = (await readGlossMemory(t.db, asked[1].glossId)).find((r) => r.dimension === 'written_receptive');
    expect(helped).toMatchObject({ reps: 1, lapses: 1 });
    expect(plain).toMatchObject({ reps: 1, lapses: 0 });
  });
});
