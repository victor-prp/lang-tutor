import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import { createSessionsRouter } from '../../../src/routes/sessions';
import { ACT_AS, actAs } from '../../support/actAs';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { clearNamespace, expectJudge, geminiBaseUrlFor, mockNamespace } from '../../support/mockServer';
import { readGlossMemory } from '../../support/progressRows';
import { insertListSession, readDayAnswers, readHelped, readStoredAnswers, readTaps, setWords, type AskedGloss } from '../../support/questions';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

/**
 * Phase 59 (spec D4, D5). The words tapped on a sentence translation card travel
 * with its judged answer or its pass. Each is stored once; a tap on the target is
 * help, a tap on a list word is a miss on that word in its memory (never in the
 * score), and any other tap costs nothing.
 */

let t: TestDb;
const namespaces: string[] = [];
const E = enrollmentOf('u_1');

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
});

afterEach(async () => {
  await Promise.all(namespaces.splice(0).map(clearNamespace));
  await t.close();
});

function buildTestApp(ns: string, logger: FakeLogger) {
  const app = new Hono();
  const deps = createTestServerDeps({ db: t.db, logger, rng: testRng(7), geminiBaseUrl: geminiBaseUrlFor(ns) });
  app.use('*', actAs());
  app.route('/api', createSessionsRouter(deps.sessions));
  return app;
}

/** A ready list session of one sentence translation for `tome`, a saved word
 *  `anchor` its map names, and the map: a free word, the target, `anchor`. */
async function start(mapped = true) {
  const tome = await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'tome', translations: ['ספר'], example: { source: 'A sentence with the tome.', target: 'משפט עם ספר.' } });
  const anchor = await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'anchor', translations: ['עוגן'] });
  const asked: AskedGloss[] = [{ glossId: tome.glossIds[0], variantId: tome.variantId, lexemeId: tome.lexemeId, form: 'tome', lemma: 'tome', translation: 'ספר' }];
  const session = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked, alternatives: [], types: ['sentence_translation'] });
  if (mapped) {
    await setWords(t.db, session.questions[0].id, [
      { start: 0, end: 4, text: 'A', glossId: null, target: false },
      { start: 5, end: 11, text: 'tome', glossId: null, target: true },
      { start: 12, end: 14, text: 'anchor', glossId: anchor.glossIds[0], target: false },
    ]);
  }
  const ns = mockNamespace('taps');
  namespaces.push(ns);
  const logger = createFakeLogger();
  const app = buildTestApp(ns, logger);
  const post = async (route: 'next-step' | 'judged-answer', body: object) => {
    const response = await app.request(`/api/sessions/${session.sessionId}/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [ACT_AS]: 'u_1' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  return { ...session, tome: tome.glossIds[0], anchor: anchor.glossIds[0], ns, logger, post };
}

const productive = async (glossId: string) =>
  (await readGlossMemory(t.db, glossId)).find((row) => row.dimension === 'written_productive');

describe('taps on a sentence translation (phase 59)', () => {
  it('stores each tap, and a list word\'s tap is a written productive miss on that word, not on the score', async () => {
    const { sessionId, questions, anchor, ns, post, logger } = await start();
    await expectJudge(ns, 'right');
    const result = await post('judged-answer', { question_id: questions[0].id, text: 'A sentence with the tome.', tapped: [2, 0] });
    expect(result).toMatchObject({ verdict: 'exact', next: { complete: true } });
    expect(await readTaps(t.db, sessionId)).toEqual([
      { position: 0, wordIndex: 0, kind: 'free', glossId: null },
      { position: 0, wordIndex: 2, kind: 'list', glossId: anchor },
    ]);
    expect(await readStoredAnswers(t.db, sessionId)).toMatchObject([{ verdict: 'exact', is_correct: true }]);
    expect(await productive(anchor)).toMatchObject({ reps: 1 });
    expect((await productive(anchor))!.stability).toBeLessThan(1);
    expect(logger.events.find((event) => event.event === 'answer_tapped')).toMatchObject({ position: 0, taps: 2, tap_misses: [anchor] });
  });

  it('makes a target tap help: the answer is stored wrong and helped', async () => {
    const { sessionId, questions, ns, post } = await start();
    await expectJudge(ns, 'right');
    await post('judged-answer', { question_id: questions[0].id, text: 'A sentence with the tome.', tapped: [1] });
    expect(await readStoredAnswers(t.db, sessionId)).toMatchObject([{ verdict: 'wrong' }]);
    expect(await readHelped(t.db, sessionId)).toEqual([true]);
    expect(await readTaps(t.db, sessionId)).toEqual([{ position: 0, wordIndex: 1, kind: 'target', glossId: null }]);
  });

  it('writes no second miss when the same answer is sent again', async () => {
    const { sessionId, questions, anchor, ns, post } = await start();
    await expectJudge(ns, 'right');
    const body = { question_id: questions[0].id, text: 'A sentence with the tome.', tapped: [2] };
    await post('judged-answer', body);
    await post('judged-answer', body);
    expect(await readTaps(t.db, sessionId)).toHaveLength(1);
    expect(await productive(anchor)).toMatchObject({ reps: 1 });
  });

  it('records the taps of a card given up, and the list word\'s miss lands', async () => {
    const { sessionId, questions, anchor, post } = await start();
    await post('judged-answer', { question_id: questions[0].id, text: '', tapped: [2] });
    expect(await readTaps(t.db, sessionId)).toEqual([{ position: 0, wordIndex: 2, kind: 'list', glossId: anchor }]);
    expect(await productive(anchor)).toMatchObject({ reps: 1 });
  });

  it('puts a list word\'s miss after its card in the day\'s answers', async () => {
    const { questions, tome, anchor, post } = await start();
    await post('judged-answer', { question_id: questions[0].id, text: '', tapped: [2] });
    const day = (await readGlossMemory(t.db, tome))[0].lastDay;
    expect((await readDayAnswers(t.db, E, day)).map((answer) => answer.glossId)).toEqual([tome, anchor]);
  });

  it('ignores taps on a card stored with no word map', async () => {
    const { sessionId, questions, anchor, post } = await start(false);
    await post('judged-answer', { question_id: questions[0].id, text: '', tapped: [2] });
    expect(await readTaps(t.db, sessionId)).toEqual([]);
    expect(await productive(anchor)).toBeUndefined();
  });
});

/**
 * Phase 62 (spec D3, D4, D6). Taps on every card that taps a sentence. On the
 * Italian cards a tap shows the Hebrew, so a list word's tap is a written
 * receptive miss (R6); a card that taps no sentence keeps none.
 */
describe('taps on every sentence card (phase 62)', () => {
  async function startAs(type: 'cloze_choice' | 'cloze_typed' | 'multiple_choice' | 'typed_meaning' | 'reverse_choice', mapped = true) {
    const tome = await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'tome', translations: ['ספר'], example: { source: 'We use tome here today.', target: 'משפט עם ספר.' } });
    const anchor = await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'anchor', translations: ['עוגן'] });
    const asked: AskedGloss[] = [{ glossId: tome.glossIds[0], variantId: tome.variantId, lexemeId: tome.lexemeId, form: 'tome', lemma: 'tome', translation: 'ספר' }];
    const session = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked, alternatives: [], types: [type] });
    if (mapped) {
      await setWords(t.db, session.questions[0].id, [
        { start: 0, end: 2, text: 'אנחנו', glossId: null, target: false },
        { start: 7, end: 11, text: 'ספר', glossId: null, target: true },
        { start: 12, end: 16, text: 'עוגן', glossId: anchor.glossIds[0], target: false },
      ]);
    }
    const ns = mockNamespace('taps62');
    namespaces.push(ns);
    const logger = createFakeLogger();
    const app = buildTestApp(ns, logger);
    const post = async (route: 'next-step' | 'judged-answer', body: object) => {
      const response = await app.request(`/api/sessions/${session.sessionId}/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [ACT_AS]: 'u_1' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    const right = (session.questions[0] as { correct_option?: number }).correct_option ?? 0;
    return { ...session, tome: tome.glossIds[0], anchor: anchor.glossIds[0], ns, logger, post, right };
  }
  const memoryOf = async (glossId: string, dimension: string) => (await readGlossMemory(t.db, glossId)).find((row) => row.dimension === dimension);

  it('stores a cloze choice\'s taps, and a list word\'s tap is a written receptive miss on it, never productive', async () => {
    const { sessionId, questions, anchor, post, right } = await startAs('cloze_choice');
    const result = await post('next-step', { question_id: questions[0].id, option_index: right, tapped: [2, 0] });
    expect(result).toMatchObject({ complete: true });
    expect(await readTaps(t.db, sessionId)).toEqual([
      { position: 0, wordIndex: 0, kind: 'free', glossId: null },
      { position: 0, wordIndex: 2, kind: 'list', glossId: anchor },
    ]);
    expect(await readStoredAnswers(t.db, sessionId)).toMatchObject([{ is_correct: true }]);
    expect(await memoryOf(anchor, 'written_receptive')).toMatchObject({ reps: 1 });
    expect((await memoryOf(anchor, 'written_receptive'))!.stability).toBeLessThan(1);
    expect(await memoryOf(anchor, 'written_productive')).toBeUndefined();
  });

  it('stores a typed cloze\'s taps with its text answer, once however often it is sent', async () => {
    const { sessionId, questions, anchor, post } = await startAs('cloze_typed');
    const body = { question_id: questions[0].id, text: 'tome', tapped: [2] };
    await post('next-step', body);
    await post('next-step', body);
    expect(await readTaps(t.db, sessionId)).toEqual([{ position: 0, wordIndex: 2, kind: 'list', glossId: anchor }]);
    expect(await memoryOf(anchor, 'written_receptive')).toMatchObject({ reps: 1 });
  });

  it('stores a typed meaning\'s taps with its judged answer', async () => {
    const { sessionId, questions, anchor, ns, post } = await startAs('typed_meaning');
    await expectJudge(ns, 'right');
    await post('judged-answer', { question_id: questions[0].id, text: 'ספר', tapped: [2] });
    expect(await readTaps(t.db, sessionId)).toEqual([{ position: 0, wordIndex: 2, kind: 'list', glossId: anchor }]);
    expect(await memoryOf(anchor, 'written_receptive')).toMatchObject({ reps: 1 });
  });

  it('never makes a target tap help on a word card: the right option stays right', async () => {
    const { sessionId, questions, post, right } = await startAs('multiple_choice');
    await post('next-step', { question_id: questions[0].id, option_index: right, tapped: [1] });
    expect(await readStoredAnswers(t.db, sessionId)).toMatchObject([{ is_correct: true }]);
    expect(await readHelped(t.db, sessionId)).not.toEqual([true]);
  });

  it('ignores taps on a card that taps no sentence', async () => {
    const reverse = await startAs('reverse_choice');
    await reverse.post('next-step', { question_id: reverse.questions[0].id, option_index: reverse.right, tapped: [2] });
    expect(await readTaps(t.db, reverse.sessionId)).toEqual([]);
  });

  it('ignores taps on a cloze stored with no map, which is answered as before (Review Focus 4)', async () => {
    const bare = await startAs('cloze_choice', false);
    await bare.post('next-step', { question_id: bare.questions[0].id, option_index: bare.right, tapped: [2] });
    expect(await readTaps(t.db, bare.sessionId)).toEqual([]);
    expect(await memoryOf(bare.anchor, 'written_receptive')).toBeUndefined();
  });

  it('puts a cloze\'s list-word miss after its card in the day\'s answers, read as a missed meaning', async () => {
    const { questions, tome, anchor, post, right } = await startAs('cloze_choice');
    await post('next-step', { question_id: questions[0].id, option_index: right, tapped: [2] });
    const day = (await readGlossMemory(t.db, tome))[0].lastDay;
    const answers = await readDayAnswers(t.db, E, day);
    expect(answers.map((answer) => answer.glossId)).toEqual([tome, anchor]);
    expect(answers[1]).toMatchObject({ type: 'typed_meaning', verdict: 'wrong' });
  });
});
