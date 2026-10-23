import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PgBoss } from 'pg-boss';

import type { SessionService } from '../../../src/services/sessions';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { startTestBoss, stopTestBoss } from '../../support/jobs';
import { markQuestionTypes, readMyWordsDays, storeMyWordsGoal } from '../../support/myWordsRows';
import { asChoice, insertListSession, type AskedGloss } from '../../support/questions';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedEnrollment, seedUser } from '../../support/seedUser';
import { setLevel } from '../../support/progressRows';
import { markSeed } from '../../support/sessionRows';
import { seedTarget, setTargetWord } from '../../support/targetRows';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

// Phase 73 (spec D2, D3). A counted My words session (main path, a practice of the list) writes
// its learner day's row when it completes: the goal in force, the sessions done, the words first
// answered in them and the words whose badge rose.

const E = enrollmentOf('u_1');
const E2 = 'e_second';
const DAY = '2026-03-04';

let t: TestDb;
let boss: PgBoss;
let logger: FakeLogger;
let clock: number;
let service: SessionService;

beforeEach(async () => {
  t = await createTestDb();
  boss = await startTestBoss(t.db);
  await seedUser(t.db, 'u_1');
  logger = createFakeLogger();
  clock = Date.parse('2026-03-04T12:00:00Z');
  service = createTestServerDeps({ db: t.db, logger, rng: testRng(7), boss, now: () => clock }).sessions;
});
afterEach(async () => {
  await stopTestBoss(boss);
  await t.close();
});

async function word(enrollmentId: string, lemma: string, translation: string): Promise<AskedGloss> {
  const saved = await seedSavedSenses(t.db, { enrollmentId, lemma, translations: [translation] });
  return { glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation };
}

/** A word one right answer lifts a badge level: mean 1.4 now, 1.6 after the written_receptive step. */
async function nearUp(enrollmentId: string, ...words: AskedGloss[]): Promise<void> {
  for (const w of words) {
    await setLevel(t.db, { enrollmentId, glossId: w.glossId, level: 1 });
    for (const dimension of ['spoken_receptive', 'spoken_productive'] as const) {
      await setLevel(t.db, { enrollmentId, glossId: w.glossId, level: 2, dimension });
    }
  }
}

/** A ready My words session over `asked`, all multiple-choice cards. */
async function mainSession(enrollmentId: string, asked: AskedGloss[], targetId?: string) {
  return insertListSession(t.db, { userId: 'u_1', enrollmentId, asked, types: asked.map(() => 'multiple_choice' as const), targetId });
}

/** Every card answered right, the last one completing the session. */
async function complete(session: { sessionId: string; questions: Parameters<typeof asChoice>[0][] }) {
  for (const question of session.questions) {
    const q = asChoice(question);
    await service.submitAnswer('u_1', session.sessionId, q.id, { option_index: q.correct_option });
  }
}

describe('a counted My words session records its day', () => {
  it('writes the row on completion: the default goal, one session, its new words and the ones moved up', async () => {
    const [apple, bread] = [await word(E, 'apple', 'תפוח'), await word(E, 'bread', 'לחם')];
    await nearUp(E, apple, bread);
    const s1 = await mainSession(E, [apple, bread]);
    await complete(s1);

    expect(await readMyWordsDays(t.db, E)).toMatchObject([
      { enrollmentId: E, day: DAY, goal: 3, sessionsDone: 1, newWords: 2, movedUp: 2, lastSessionId: s1.sessionId },
    ]);
    expect(logger.events.filter((entry) => entry.event === 'my_words_day_recorded')).toMatchObject([
      { enrollment_id: E, day: DAY, goal: 3, sessions_done: 1, new_words: 2, moved_up: 2, session_id: s1.sessionId },
    ]);
  });

  it('rewrites it on a second completion, a word raised twice counted once', async () => {
    const [apple, bread] = [await word(E, 'apple', 'תפוח'), await word(E, 'bread', 'לחם')];
    await nearUp(E, apple, bread);
    await complete(await mainSession(E, [apple]));
    await nearUp(E, apple);
    const s2 = await mainSession(E, [apple, bread]);
    await complete(s2);

    expect(await readMyWordsDays(t.db, E)).toMatchObject([
      { sessionsDone: 2, newWords: 2, movedUp: 2, lastSessionId: s2.sessionId },
    ]);
  });

  it("writes nothing for a target path's session", async () => {
    const apple = await word(E, 'apple', 'תפוח');
    const homework = await seedTarget(t.db, { enrollmentId: E, kind: 'homework', dueOn: '2026-03-20', glossIds: [apple.glossId] });
    await setTargetWord(t.db, { targetId: homework, glossId: apple.glossId, startedOn: '2026-03-03', halves: {} });
    await complete(await mainSession(E, [apple], homework));

    expect(await readMyWordsDays(t.db, E)).toEqual([]);
  });

  it('writes nothing for a seed or a question-types session', async () => {
    const apple = await word(E, 'apple', 'תפוח');
    const seed = await mainSession(E, [apple]);
    await markSeed(t.db, seed.sessionId);
    await complete(seed);
    const testers = await mainSession(E, [apple]);
    await markQuestionTypes(t.db, testers.sessionId);
    await complete(testers);

    expect(await readMyWordsDays(t.db, E)).toEqual([]);
  });

  it("lands a session started at 23:50 and completed at 00:10 on the new day, in the learner's zone", async () => {
    const apple = await word(E, 'apple', 'תפוח');
    const bread = await word(E, 'bread', 'לחם');
    const session = await mainSession(E, [apple, bread]);
    clock = Date.parse('2026-03-04T23:50:00Z');
    const [first, last] = session.questions.map(asChoice);
    await service.submitAnswer('u_1', session.sessionId, first.id, { option_index: first.correct_option });
    clock = Date.parse('2026-03-05T00:10:00Z');
    await service.submitAnswer('u_1', session.sessionId, last.id, { option_index: last.correct_option });

    expect(await readMyWordsDays(t.db, E)).toMatchObject([{ day: '2026-03-05', sessionsDone: 1 }]);
  });

  it('keeps two enrollments of one learner apart', async () => {
    await seedEnrollment(t.db, { id: E2, userId: 'u_1', targetLanguage: 'it' });
    const apple = await word(E, 'apple', 'תפוח');
    const mela = await word(E2, 'mela', 'תפוח');
    await complete(await mainSession(E, [apple]));
    await complete(await mainSession(E2, [mela]));
    await complete(await mainSession(E2, [mela]));

    expect(await readMyWordsDays(t.db, E)).toMatchObject([{ sessionsDone: 1 }]);
    expect(await readMyWordsDays(t.db, E2)).toMatchObject([{ sessionsDone: 2 }]);
  });

  it('does not count a word first answered in a target session new for a later My words session', async () => {
    const apple = await word(E, 'apple', 'תפוח');
    const homework = await seedTarget(t.db, { enrollmentId: E, kind: 'homework', dueOn: '2026-03-20', glossIds: [apple.glossId] });
    await setTargetWord(t.db, { targetId: homework, glossId: apple.glossId, startedOn: '2026-03-03', halves: {} });
    await complete(await mainSession(E, [apple], homework));
    await complete(await mainSession(E, [apple]));

    expect(await readMyWordsDays(t.db, E)).toMatchObject([{ sessionsDone: 1, newWords: 0 }]);
  });

  it('stores a null goal for a goal that is off (stored 0)', async () => {
    await storeMyWordsGoal(t.db, E, 0);
    await complete(await mainSession(E, [await word(E, 'apple', 'תפוח')]));

    expect(await readMyWordsDays(t.db, E)).toMatchObject([{ goal: null, sessionsDone: 1 }]);
  });
});
