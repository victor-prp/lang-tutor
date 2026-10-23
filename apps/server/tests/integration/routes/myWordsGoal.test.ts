import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { CurrentSessionResponse, MyWordsGoal } from '@lang-tutor/core/api';
import { Hono } from 'hono';

import { goalMinutes } from '../../../src/domain/myWordsGoal';

import { createMyWordsGoalRouter } from '../../../src/routes/myWordsGoal';
import { createSessionsRouter } from '../../../src/routes/sessions';
import { ACT_AS, actAs } from '../../support/actAs';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { markQuestionTypes, readMyWordsDays, readStoredMyWordsGoal, storeMyWordsGoal } from '../../support/myWordsRows';
import { asChoice, insertListSession, type AskedGloss } from '../../support/questions';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { seedTarget, setTargetWord } from '../../support/targetRows';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

// Phase 73 (spec D1, D4, D7). The My words goal's routes, today's numbers on home's read, and the
// session read's kind.
const E = enrollmentOf('u_1');
const DAY = '2026-03-04';

let t: TestDb;
let logger: FakeLogger;
let app: Hono;
let service: ReturnType<typeof createTestServerDeps>['sessions'];

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  await seedUser(t.db, 'u_2');
  logger = createFakeLogger();
  const deps = createTestServerDeps({ db: t.db, logger, rng: testRng(7), now: () => Date.parse('2026-03-04T12:00:00Z') });
  service = deps.sessions;
  app = new Hono();
  app.use('*', actAs());
  app.route('/api', createMyWordsGoalRouter(deps.myWordsGoal));
  app.route('/api', createSessionsRouter(deps.sessions));
});
afterEach(async () => {
  await t.close();
});

const send = (method: string, path: string, body?: unknown, actor = 'u_1') =>
  app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', [ACT_AS]: actor },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const getGoal = async (): Promise<MyWordsGoal> => (await send('GET', `/api/enrollments/${E}/my-words-goal`)).json();
const putGoal = (body: unknown, actor = 'u_1') => send('PUT', `/api/enrollments/${E}/my-words-goal`, body, actor);
const stored = async () => ({ my_words_goal: await readStoredMyWordsGoal(t.db, E) });
const readCurrent = async (query = ''): Promise<CurrentSessionResponse> =>
  (await send('GET', `/api/enrollments/${E}/sessions/current${query}`)).json();

async function word(lemma: string, translation: string): Promise<AskedGloss> {
  const saved = await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [translation] });
  return { glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation };
}
/** A counted My words session over one word, completed. */
async function countedSession(w: AskedGloss) {
  const session = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked: [w], types: ['multiple_choice'] });
  for (const question of session.questions) {
    const q = asChoice(question);
    await service.submitAnswer('u_1', session.sessionId, q.id, { option_index: q.correct_option });
  }
  return session;
}

describe('GET and PUT /api/enrollments/{id}/my-words-goal', () => {
  it('answers 3 when never set', async () => {
    expect(await getGoal()).toEqual({ goal: 3 });
  });

  it('stores a choice, the default as null and off as 0', async () => {
    const five = await putGoal({ goal: 5 });
    expect(five.status).toBe(200);
    expect(await five.json()).toEqual({ goal: 5 });
    expect(await stored()).toEqual({ my_words_goal: 5 });
    expect(await getGoal()).toEqual({ goal: 5 });

    expect(await (await putGoal({ goal: 3 })).json()).toEqual({ goal: 3 });
    expect(await stored()).toEqual({ my_words_goal: null });

    expect(await (await putGoal({ goal: null })).json()).toEqual({ goal: null });
    expect(await stored()).toEqual({ my_words_goal: 0 });
    expect(await getGoal()).toEqual({ goal: null });
  });

  it.each([[21], [0], [2.5], ['3']])('refuses %p with 400 and changes nothing', async (goal) => {
    expect((await putGoal({ goal })).status).toBe(400);
    expect((await putGoal({})).status).toBe(400);
    expect(await stored()).toEqual({ my_words_goal: null });
  });

  it("refuses another learner's enrollment with 403 and an unknown one with 404", async () => {
    expect((await putGoal({ goal: 5 }, 'u_2')).status).toBe(403);
    expect((await send('GET', `/api/enrollments/${E}/my-words-goal`, undefined, 'u_2')).status).toBe(403);
    expect(await stored()).toEqual({ my_words_goal: null });
    expect((await send('GET', '/api/enrollments/e_nobody/my-words-goal')).status).toBe(404);
  });

  it("rewrites today's row with the new goal and logs goal_changed", async () => {
    await countedSession(await word('apple', 'תפוח'));
    expect(await readMyWordsDays(t.db, E)).toMatchObject([{ day: DAY, goal: 3, sessionsDone: 1 }]);

    await putGoal({ goal: 7 });
    expect(await readMyWordsDays(t.db, E)).toMatchObject([{ day: DAY, goal: 7, sessionsDone: 1 }]);
    expect(logger.events.filter((e) => e.event === 'my_words_day_recorded' && e.reason === 'goal_changed')).toMatchObject([
      { enrollment_id: E, day: DAY, goal: 7, sessions_done: 1 },
    ]);
  });

  it('writes no row on a day without one', async () => {
    await putGoal({ goal: 7 });
    expect(await readMyWordsDays(t.db, E)).toEqual([]);
  });
});

describe('GET current: today', () => {
  it('is zeros with the default goal before a counted session, then the day after one', async () => {
    expect((await readCurrent()).today).toEqual({ goal: 3, sessions_done: 0, new_words: 0, moved_up: 0, minutes: goalMinutes(3) });

    await countedSession(await word('apple', 'תפוח'));
    expect((await readCurrent()).today).toEqual({ goal: 3, sessions_done: 1, new_words: 1, moved_up: 0, minutes: goalMinutes(3) });
  });

  it('shows the goal in force now: lowered to 1 after two sessions, off as null with no minutes', async () => {
    await countedSession(await word('apple', 'תפוח'));
    await countedSession(await word('bread', 'לחם'));
    await storeMyWordsGoal(t.db, E, 1);
    expect((await readCurrent()).today).toMatchObject({ goal: 1, sessions_done: 2, minutes: goalMinutes(1) });

    await storeMyWordsGoal(t.db, E, 0);
    expect((await readCurrent()).today).toMatchObject({ goal: null, sessions_done: 2, minutes: 0 });
  });

  it("is absent on a target's path", async () => {
    const apple = await word('apple', 'תפוח');
    const homework = await seedTarget(t.db, { enrollmentId: E, kind: 'homework', dueOn: '2026-03-20', glossIds: [apple.glossId] });
    await setTargetWord(t.db, { targetId: homework, glossId: apple.glossId, startedOn: '2026-03-03', halves: {} });
    expect('today' in (await readCurrent(`?target_id=${homework}`))).toBe(false);
  });
});

describe('GET /sessions/{id}: kind', () => {
  it('names practice, and question_types for a tester\'s session', async () => {
    const apple = await word('apple', 'תפוח');
    const practice = await countedSession(apple);
    const testers = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked: [apple], types: ['multiple_choice'] });
    await markQuestionTypes(t.db, testers.sessionId);

    const read = async (id: string) => (await (await send('GET', `/api/sessions/${id}`)).json()) as { kind?: string };
    expect((await read(practice.sessionId)).kind).toBe('practice');
    expect((await read(testers.sessionId)).kind).toBe('question_types');
  });
});
