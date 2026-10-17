import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { Question } from '@lang-tutor/core/api';
import type { QuestionType } from '@lang-tutor/core/domain';
import { sql } from 'drizzle-orm';

import { recomputeProgress } from '../../../src/db/progressRecompute';
import { KNOWN_STABILITY } from '../../../src/domain/chooseConstants';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger } from '../../support/fakes';
import {
  insertAnsweredSession,
  insertProgressRows,
  readMemory,
  readProgress,
  readSnapshot,
  saveSessionGlosses,
  setLevel,
} from '../../support/progressRows';
import { asChoice, insertListSession, type AskedGloss } from '../../support/questions';
import { enrollmentOf, makeBot, seedUser } from '../../support/seedUser';
import { createTestServerDeps } from '../../support/serverDeps';
import {
  readStartedOn,
  readTargetSkillEventTimes,
  readTargetSkillEvents,
  readTargetSkills,
  seedTarget,
  spoilTargetSkills,
} from '../../support/targetRows';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

let t: TestDb;
const E = enrollmentOf('u_1');
let kite: { lexemeId: string; variantIds: string[]; glossIds: string[] };

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  kite = await insertLexeme(t.db, {
    lemma: 'kite',
    languageCode: 'en',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'toy' }],
    variants: [
      {
        form: 'kite',
        kind: 'word',
        entryRank: 0,
        translations: [
          { senseCode: 'toy', rank: 0, translation: 'עפיפון', exampleSource: null, exampleTarget: null },
        ],
      },
    ],
  });
});
afterEach(async () => {
  await t.close();
});

async function savedAt(at: string) {
  await t.db.execute(sql`
    insert into vocabulary_entries (enrollment_id, gloss_id, lexeme_id, lemma, variant_id, created_at, added_by_user_id)
    values (${E}, ${kite.glossIds[0]}, ${kite.lexemeId}, (select lemma from dict_lexemes where id = ${kite.lexemeId}),
            ${kite.variantIds[0]}, ${at}::timestamptz, 'u_1')`);
  await insertProgressRows(t.db, E, [kite.glossIds[0]]);
}

/** A one-question session about kite, answered once at `at`. */
const session = (status: 'completed' | 'skipped' | 'ready', correct: boolean, at: string) =>
  insertAnsweredSession(t.db, {
    userId: 'u_1',
    enrollmentId: E,
    status,
    asked: [{ glossId: kite.glossIds[0], variantId: kite.variantIds[0], translation: 'עפיפון' }],
    answers: [{ position: 0, correct, at }],
  });

const receptive = async () =>
  (await readProgress(t.db, E)).find((row) => row.dimension === 'written_receptive');

describe('recomputeProgress', () => {
  it('rebuilds levels from ended sessions in the order they ended, and their snapshots', async () => {
    await savedAt('2026-01-01 00:00:00+00');
    const first = await session('completed', true, '2026-01-05 10:00:00+00');
    const second = await session('skipped', true, '2026-01-06 10:00:00+00');
    const third = await session('completed', false, '2026-01-07 10:00:00+00');
    await session('ready', true, '2026-01-20 10:00:00+00'); // open: does not count
    await setLevel(t.db, { enrollmentId: E, glossId: kite.glossIds[0], level: 5 }); // junk to reset

    expect(await recomputeProgress(t.db)).toEqual({ sessions: 3 });

    expect(await receptive()).toMatchObject({ level: 3, lastStepOn: '2026-01-06', lastWrongOn: '2026-01-07' });
    expect(await readSnapshot(t.db, first)).toHaveLength(5);
    expect(await readSnapshot(t.db, second)).toHaveLength(5);
    expect((await readSnapshot(t.db, third)).find((r) => r.dimension === 'written_receptive')).toMatchObject({
      levelBefore: 3,
      levelAfter: 3,
    });
  });

  it('does not count a session that ended before the sense was saved', async () => {
    await savedAt('2026-01-10 00:00:00+00');
    const before = await session('completed', true, '2026-01-05 10:00:00+00');
    await recomputeProgress(t.db);
    expect(await receptive()).toMatchObject({ level: 1, lastStepOn: null });
    expect(await readSnapshot(t.db, before)).toEqual([]);
  });

  it('is idempotent', async () => {
    await savedAt('2026-01-01 00:00:00+00');
    await session('completed', true, '2026-01-05 10:00:00+00');
    await recomputeProgress(t.db);
    const once = await readProgress(t.db, E);
    await recomputeProgress(t.db);
    expect(await readProgress(t.db, E)).toEqual(once);
  });

  // The docstring on recomputeProgress says this test keeps it in step with
  // recordProgress in services/sessions.ts. That holds only if the live path's
  // output is the expectation, so none of it is computed by hand here: real
  // sessions run through the session service, and the recompute must write
  // back exactly what that service already wrote.
  //
  // One completed and one skipped session, each the seed session of its own
  // learner: a second session for the same learner is a list session, which the
  // prepare-session job fills through the language model, so it is out of reach
  // of a test with no MockServer.
  it('writes back exactly what the live path wrote', async () => {
    await seedUser(t.db, 'u_2');
    const E2 = enrollmentOf('u_2');
    const { sessions: live } = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });

    // Each session is answered by its own learner.
    const answer = (learner: string, sessionId: string, question: Question, right: boolean) => {
      const q = asChoice(question);
      return live.submitAnswer(learner, sessionId, q.id, {
        option_index: right ? q.correct_option : (q.correct_option + 1) % q.options.length,
      });
    };

    // Completed: three saved senses, answered right, wrong, right; the other
    // seven questions are about unsaved senses and must change nothing.
    const { sessionId: completed } = await live.createNextSession('u_1', E, { listening: false, speaking: false });
    const completedRecord = await live.getSession('u_1', completed);
    await saveSessionGlosses(t.db, { sessionId: completed, enrollmentId: E, positions: [0, 1, 2] });
    for (const [i, q] of completedRecord.questions.entries()) await answer('u_1', completed, q, i !== 1);
    expect((await live.getSession('u_1', completed)).status).toBe('completed');

    // Skipped: two saved senses, one answered right and one wrong, then the skip.
    const { sessionId: skipped } = await live.createNextSession('u_2', E2, { listening: false, speaking: false });
    const skippedRecord = await live.getSession('u_2', skipped);
    await saveSessionGlosses(t.db, { sessionId: skipped, enrollmentId: E2, positions: [0, 1] });
    await answer('u_2', skipped, skippedRecord.questions[0], true);
    await answer('u_2', skipped, skippedRecord.questions[1], false);
    await live.skipSession('u_2', skipped);

    const written = async () => ({
      first: await readProgress(t.db, E),
      second: await readProgress(t.db, E2),
      completedSnapshot: await readSnapshot(t.db, completed),
      skippedSnapshot: await readSnapshot(t.db, skipped),
    });
    const before = await written();
    // Guards against comparing two empty results, and against a recompute that
    // would agree with a live path that wrote nothing.
    expect(before.completedSnapshot).toHaveLength(15);
    expect(before.skippedSnapshot).toHaveLength(10);
    expect(before.first.some((row) => row.level === 2)).toBe(true);
    expect(before.second.some((row) => row.lastWrongOn !== null)).toBe(true);

    expect(await recomputeProgress(t.db)).toEqual({ sessions: 2 });

    expect(await written()).toEqual(before);
  });

  // Phase 23. The recompute reads a typed answer's stored verdict and a
  // reversed card's capped evidence the way the live path did.
  it('writes back exactly what the live path wrote for a session of all three types', async () => {
    const { sessions: live } = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });
    const words = [];
    for (const [lemma, translation] of [
      ['tome', 'ספר'],
      ['quill', 'נוצה'],
      ['lantern', 'פנס'],
    ]) {
      const saved = await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [translation] });
      words.push({ glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation });
    }
    const { sessionId, questions } = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked: words });
    expect(questions.map((q) => q.type)).toEqual(['multiple_choice', 'reverse_choice', 'typed_translation']);

    await live.submitAnswer('u_1', sessionId, questions[0].id, { option_index: 0 });
    await live.submitAnswer('u_1', sessionId, questions[1].id, { option_index: 0 });
    // One letter swapped in a seven-letter word: a near miss.
    const done = await live.submitAnswer('u_1', sessionId, questions[2].id, { text: 'lantren' });
    expect(done.status).toBe('completed');

    const written = async () => ({ progress: await readProgress(t.db, E), snapshot: await readSnapshot(t.db, sessionId) });
    const before = await written();
    const level = (glossId: string, dimension: string) =>
      before.progress.find((row) => row.glossId === glossId && row.dimension === dimension)!.level;
    // The live path's own evidence (spec D6), so the comparison below is not
    // between two empty results.
    expect(level(words[0].glossId, 'written_receptive')).toBe(2);
    expect(level(words[1].glossId, 'written_productive')).toBe(2);
    expect(level(words[2].glossId, 'written_productive')).toBe(2);
    expect(level(words[2].glossId, 'spelling')).toBe(1);

    expect(await recomputeProgress(t.db)).toEqual({ sessions: 1 });
    expect(await written()).toEqual(before);
  });

  it('writes back exactly what the live path wrote for a session of every phase 24 type', async () => {
    const { sessions: live } = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });
    const words = [];
    for (const [lemma, translation] of [
      ['tome', 'ספר'], ['quill', 'נוצה'], ['lantern', 'פנס'],
      ['kettle', 'קומקום'], ['pillow', 'כרית'], ['ladder', 'סולם'], ['bucket', 'דלי'],
    ]) {
      const saved = await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [translation] });
      words.push({ glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation });
    }
    const { sessionId, questions } = await insertListSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      asked: words,
      types: ['listen_choice', 'letter_tiles', 'dictation', 'matching', 'matching', 'matching', 'matching'],
    });

    await live.submitAnswer('u_1', sessionId, questions[0].id, { option_index: 0 });
    await live.submitAnswer('u_1', sessionId, questions[1].id, { text: 'quill' });
    await live.submitAnswer('u_1', sessionId, questions[2].id, { text: 'lantern' });
    // Board words: right except the second, which first tried the fifth meaning.
    await live.submitAnswer('u_1', sessionId, questions[3].id, { option_index: 0 });
    await live.submitAnswer('u_1', sessionId, questions[4].id, { option_index: 4 });
    await live.submitAnswer('u_1', sessionId, questions[5].id, { option_index: 2 });
    const done = await live.submitAnswer('u_1', sessionId, questions[6].id, { option_index: 3 });
    expect(done.status).toBe('completed');

    const written = async () => ({ progress: await readProgress(t.db, E), snapshot: await readSnapshot(t.db, sessionId) });
    const before = await written();
    const level = (glossId: string, dimension: string) =>
      before.progress.find((row) => row.glossId === glossId && row.dimension === dimension)!.level;
    expect(level(words[0].glossId, 'spoken_receptive')).toBe(2);
    expect(level(words[1].glossId, 'written_productive')).toBe(2);
    expect(level(words[1].glossId, 'spelling')).toBe(1);
    expect(level(words[2].glossId, 'spoken_receptive')).toBe(2);
    expect(level(words[2].glossId, 'spelling')).toBe(2);
    expect(level(words[3].glossId, 'written_receptive')).toBe(2);
    expect(level(words[4].glossId, 'written_receptive')).toBe(1);

    expect(await recomputeProgress(t.db)).toEqual({ sessions: 1 });
    expect(await written()).toEqual(before);
  });
  // Phase 25. A spoken answer, a give-up and a typed say-the-translation answer
  // are replayed from their stored verdicts, as the live path judged them.
  it('writes back exactly what the live path wrote for a session of speaking cards', async () => {
    const { sessions: live } = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });
    const words = [];
    for (const [lemma, translation] of [
      ['tome', 'ספר'], ['quill', 'נוצה'], ['lantern', 'פנס'],
    ]) {
      const saved = await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [translation] });
      words.push({ glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation });
    }
    const { sessionId, questions } = await insertListSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      asked: words,
      types: ['read_aloud', 'say_translation', 'say_translation'],
    });

    await live.submitAnswer('u_1', sessionId, questions[0].id, { heard: 'tome' });
    await live.submitAnswer('u_1', sessionId, questions[1].id, { pass: 'show_answer' });
    const done = await live.submitAnswer('u_1', sessionId, questions[2].id, { text: 'lantern' });
    expect(done.status).toBe('completed');

    const written = async () => ({ progress: await readProgress(t.db, E), snapshot: await readSnapshot(t.db, sessionId) });
    const before = await written();
    const level = (glossId: string, dimension: string) =>
      before.progress.find((row) => row.glossId === glossId && row.dimension === dimension)!.level;
    expect(level(words[0].glossId, 'spoken_productive')).toBe(2);
    expect(level(words[2].glossId, 'written_productive')).toBe(2);
    expect(before.snapshot.length).toBeGreaterThan(0);

    expect(await recomputeProgress(t.db)).toEqual({ sessions: 1 });
    expect(await written()).toEqual(before);
  });

  // Phase 35 (spec D8). Three sessions over two days, the first two on the same
  // day, one word wrong once: the recompute writes back the memory the live path wrote.
  it('rebuilds the memory the live path wrote, over three sessions on two days', async () => {
    let clock = Date.parse('2026-03-04T09:00:00Z');
    const { sessions: live } = createTestServerDeps({
      db: t.db,
      logger: createFakeLogger(),
      rng: testRng(7),
      now: () => clock,
    });
    const words: Parameters<typeof insertListSession>[1]['asked'] = [];
    for (const [lemma, translation] of [['tome', 'ספר'], ['quill', 'נוצה']]) {
      const saved = await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [translation] });
      words.push({ glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation });
    }
    const play = async (rights: boolean[]) => {
      const { sessionId, questions } = await insertListSession(t.db, {
        userId: 'u_1',
        enrollmentId: E,
        asked: words,
        types: ['multiple_choice', 'multiple_choice'],
      });
      for (const [i, question] of questions.entries()) {
        const q = asChoice(question);
        await live.submitAnswer('u_1', sessionId, q.id, {
          option_index: rights[i] ? q.correct_option : (q.correct_option + 1) % q.options.length,
        });
      }
      return sessionId;
    };
    await play([true, true]);
    clock += 3_600_000;
    await play([true, false]);
    clock += 24 * 3_600_000;
    await play([false, true]);

    const before = await readMemory(t.db, E);
    expect(before).toHaveLength(2);
    expect(before.map((row) => row.reps)).toEqual([3, 3]);
    expect(before.some((row) => row.lapses > 0)).toBe(true);

    expect(await recomputeProgress(t.db)).toEqual({ sessions: 3 });
    expect(await readMemory(t.db, E)).toEqual(before);
  });

  // Phase 46 (spec D1). A skill right on day 0 and day 1 reaches the bar on day 1;
  // a miss on day 4 drops it below, and the date stays. The recompute replays the
  // same applySession, so it writes back the date the live path wrote.
  it('dates the day a skill reached the bar, keeps it after a lapse, and rebuilds it', async () => {
    let clock = Date.parse('2026-03-04T09:00:00Z');
    const { sessions: live } = createTestServerDeps({
      db: t.db,
      logger: createFakeLogger(),
      rng: testRng(7),
      now: () => clock,
    });
    const saved = await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'tome', translations: ['ספר'] });
    const word = { glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: 'tome', lemma: 'tome', translation: 'ספר' };
    const play = async (right: boolean) => {
      const { sessionId, questions } = await insertListSession(t.db, {
        userId: 'u_1',
        enrollmentId: E,
        asked: [word],
        types: ['multiple_choice'],
      });
      const q = asChoice(questions[0]);
      await live.submitAnswer('u_1', sessionId, q.id, {
        option_index: right ? q.correct_option : (q.correct_option + 1) % q.options.length,
      });
    };
    await play(true);
    clock += 24 * 3_600_000;
    await play(true);
    clock += 3 * 24 * 3_600_000;
    await play(false);

    const before = await readMemory(t.db, E);
    expect(before).toHaveLength(1);
    expect(before[0].stability).toBeLessThan(KNOWN_STABILITY);
    expect(before[0].reachedOn).toBe('2026-03-05');

    expect(await recomputeProgress(t.db)).toEqual({ sessions: 3 });
    expect(await readMemory(t.db, E)).toEqual(before);
  });

  // Phase 57 (spec D3, D4). Target skills, their events and the day each word started, replayed
  // from the answers as the live path wrote them. Each session counts for the targets active
  // when its answers were given, at the cap of the due date they had then: a target ended
  // early keeps what its sessions before the end gave it, and one whose date moved keeps the
  // caps its earlier sessions were played under. The learner is a bot, so the day is the
  // profile's while every instant is the real clock's, as the targets service's are.
  it('rebuilds target skills, their events and started_on as the live path wrote them', async () => {
    await makeBot(t.db, 'u_1', '2030-01-08');
    const deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });
    const word = async (lemma: string, translation: string): Promise<AskedGloss> => {
      const saved = await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [translation] });
      return { glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation };
    };
    const tome = await word('tome', 'ספר');
    const quill = await word('quill', 'נוצה');
    const play = async (cards: [AskedGloss, QuestionType, boolean][]) => {
      const { sessionId, questions } = await insertListSession(t.db, {
        userId: 'u_1',
        enrollmentId: E,
        asked: cards.map(([asked]) => asked),
        types: cards.map(([, type]) => type),
      });
      for (const [i, [asked, type, right]] of cards.entries()) {
        if (type === 'multiple_choice') {
          const q = asChoice(questions[i]);
          await deps.sessions.submitAnswer('u_1', sessionId, q.id, { option_index: right ? q.correct_option : (q.correct_option + 1) % q.options.length });
        } else {
          await deps.sessions.submitAnswer('u_1', sessionId, questions[i].id, { text: right ? asked.form : 'zzzz' });
        }
      }
    };
    // Five days left on the first day: cap 7; twenty for the homework: cap 4.
    const exam = await seedTarget(t.db, { enrollmentId: E, kind: 'exam', dueOn: '2030-01-13', glossIds: [tome.glossId, quill.glossId] });
    const homework = await seedTarget(t.db, { enrollmentId: E, kind: 'homework', dueOn: '2030-01-28', glossIds: [tome.glossId] });

    await play([[tome, 'typed_translation', true], [quill, 'multiple_choice', true]]);
    await deps.targets.end('u_1', homework);
    await makeBot(t.db, 'u_1', '2030-01-09');
    await play([[tome, 'typed_translation', false], [quill, 'typed_translation', true]]);
    await deps.targets.changeDate('u_1', exam, { due_on: '2030-02-20' });
    await makeBot(t.db, 'u_1', '2030-01-10');
    await play([[quill, 'multiple_choice', false]]);

    const written = async () => ({
      skills: [await readTargetSkills(t.db, exam), await readTargetSkills(t.db, homework)],
      events: [await readTargetSkillEvents(t.db, exam), await readTargetSkillEvents(t.db, homework)],
      started: [await readStartedOn(t.db, exam), await readStartedOn(t.db, homework)],
    });
    const before = await written();
    // The live path's own values, so the comparison below is not between two empty results,
    // and so a replay at today's date (cap 2) or without the ended homework would differ.
    const halves = (rows: { glossId: string; dimension: string; halves: number }[]) =>
      Object.fromEntries(rows.map((row) => [`${row.glossId === tome.glossId ? 'tome' : 'quill'}:${row.dimension}`, row.halves]));
    expect(halves(before.skills[0])).toEqual({
      'tome:written_receptive': 4,
      'tome:written_productive': 0,
      'tome:spelling': 4,
      'quill:written_receptive': 2,
      'quill:written_productive': 4,
      'quill:spelling': 4,
    });
    expect(halves(before.skills[1])).toEqual({ 'tome:written_receptive': 4, 'tome:written_productive': 4, 'tome:spelling': 4 });
    expect(before.events[0].map((event) => event.why)).toContain('miss');
    expect(before.started).toEqual([
      { [tome.glossId]: '2030-01-08', [quill.glossId]: '2030-01-08' },
      { [tome.glossId]: '2030-01-08' },
    ]);

    await spoilTargetSkills(t.db); // junk the rebuild must replace
    expect(await recomputeProgress(t.db)).toEqual({ sessions: 3 });
    expect(await written()).toEqual(before);
  });

  // Final review T4. Each event is stamped with its session's last answer, live and rebuilt
  // alike, so a rebuilt log reads in the order the live one does, a skip's too.
  it('stamps each target skill event with its session last answer, live and rebuilt alike', async () => {
    await makeBot(t.db, 'u_1', '2030-01-08');
    const deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });
    const saved = await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'tome', translations: ['ספר'] });
    const tome: AskedGloss = { glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: 'tome', lemma: 'tome', translation: 'ספר' };
    const exam = await seedTarget(t.db, { enrollmentId: E, kind: 'exam', dueOn: '2030-01-13', glossIds: [tome.glossId] });
    const play = async (types: QuestionType[], answered: number, end: 'complete' | 'skip') => {
      const { sessionId, questions } = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked: types.map(() => tome), types });
      for (const question of questions.slice(0, answered)) {
        const choice = asChoice(question);
        await deps.sessions.submitAnswer('u_1', sessionId, question.id, { option_index: choice.correct_option });
      }
      if (end === 'skip') await deps.sessions.skipSession('u_1', sessionId);
      return sessionId;
    };
    // A session answered and skipped later, then one answered to its end.
    const skipped = await play(['multiple_choice', 'multiple_choice'], 1, 'skip');
    await makeBot(t.db, 'u_1', '2030-01-09');
    const completed = await play(['multiple_choice'], 1, 'complete');

    const live = await readTargetSkillEventTimes(t.db, exam);
    expect(live.map(({ sessionId, atLastAnswer }) => ({ sessionId, atLastAnswer }))).toEqual([
      { sessionId: skipped, atLastAnswer: true },
      { sessionId: completed, atLastAnswer: true },
    ]);

    expect(await recomputeProgress(t.db)).toEqual({ sessions: 2 });
    expect(await readTargetSkillEventTimes(t.db, exam)).toEqual(live);
  });
});
