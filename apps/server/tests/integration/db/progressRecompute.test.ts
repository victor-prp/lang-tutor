import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { Question } from '@lang-tutor/core/api';
import { sql } from 'drizzle-orm';

import { recomputeProgress } from '../../../src/db/progressRecompute';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger } from '../../support/fakes';
import {
  insertAnsweredSession,
  insertProgressRows,
  readProgress,
  readSnapshot,
  saveSessionSenses,
  setLevel,
} from '../../support/progressRows';
import { asChoice, insertListSession } from '../../support/questions';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

let t: TestDb;
const E = enrollmentOf('u_1');
let kite: { lexemeId: string; variantIds: string[]; senseIds: string[] };

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
    insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, lemma, variant_id, created_at)
    values (${E}, ${kite.senseIds[0]}, ${kite.lexemeId}, (select lemma from dict_lexemes where id = ${kite.lexemeId}),
            ${kite.variantIds[0]}, ${at}::timestamptz)`);
  await insertProgressRows(t.db, E, [kite.senseIds[0]]);
}

/** A one-question session about kite, answered once at `at`. */
const session = (status: 'completed' | 'skipped' | 'ready', correct: boolean, at: string) =>
  insertAnsweredSession(t.db, {
    userId: 'u_1',
    enrollmentId: E,
    status,
    asked: [{ senseId: kite.senseIds[0], variantId: kite.variantIds[0], translation: 'עפיפון' }],
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
    await setLevel(t.db, { enrollmentId: E, senseId: kite.senseIds[0], level: 5 }); // junk to reset

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

    const answer = (sessionId: string, question: Question, right: boolean) => {
      const q = asChoice(question);
      return live.submitAnswer(sessionId, q.id, {
        option_index: right ? q.correct_option : (q.correct_option + 1) % q.options.length,
      });
    };

    // Completed: three saved senses, answered right, wrong, right; the other
    // seven questions are about unsaved senses and must change nothing.
    const { sessionId: completed } = await live.createNextSession(E, { listening: false, speaking: false });
    const completedRecord = await live.getSession(completed);
    await saveSessionSenses(t.db, { sessionId: completed, enrollmentId: E, positions: [0, 1, 2] });
    for (const [i, q] of completedRecord.questions.entries()) await answer(completed, q, i !== 1);
    expect((await live.getSession(completed)).status).toBe('completed');

    // Skipped: two saved senses, one answered right and one wrong, then the skip.
    const { sessionId: skipped } = await live.createNextSession(E2, { listening: false, speaking: false });
    const skippedRecord = await live.getSession(skipped);
    await saveSessionSenses(t.db, { sessionId: skipped, enrollmentId: E2, positions: [0, 1] });
    await answer(skipped, skippedRecord.questions[0], true);
    await answer(skipped, skippedRecord.questions[1], false);
    await live.skipSession(skipped);

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
      words.push({ senseId: saved.senseIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation });
    }
    const { sessionId, questions } = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked: words });
    expect(questions.map((q) => q.type)).toEqual(['multiple_choice', 'reverse_choice', 'typed_translation']);

    await live.submitAnswer(sessionId, questions[0].id, { option_index: 0 });
    await live.submitAnswer(sessionId, questions[1].id, { option_index: 0 });
    // One letter swapped in a seven-letter word: a near miss.
    const done = await live.submitAnswer(sessionId, questions[2].id, { text: 'lantren' });
    expect(done.status).toBe('completed');

    const written = async () => ({ progress: await readProgress(t.db, E), snapshot: await readSnapshot(t.db, sessionId) });
    const before = await written();
    const level = (senseId: string, dimension: string) =>
      before.progress.find((row) => row.senseId === senseId && row.dimension === dimension)!.level;
    // The live path's own evidence (spec D6), so the comparison below is not
    // between two empty results.
    expect(level(words[0].senseId, 'written_receptive')).toBe(2);
    expect(level(words[1].senseId, 'written_productive')).toBe(2);
    expect(level(words[2].senseId, 'written_productive')).toBe(2);
    expect(level(words[2].senseId, 'spelling')).toBe(1);

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
      words.push({ senseId: saved.senseIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation });
    }
    const { sessionId, questions } = await insertListSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      asked: words,
      types: ['listen_choice', 'letter_tiles', 'dictation', 'matching', 'matching', 'matching', 'matching'],
    });

    await live.submitAnswer(sessionId, questions[0].id, { option_index: 0 });
    await live.submitAnswer(sessionId, questions[1].id, { text: 'quill' });
    await live.submitAnswer(sessionId, questions[2].id, { text: 'lantern' });
    // Board words: right except the second, which first tried the fifth meaning.
    await live.submitAnswer(sessionId, questions[3].id, { option_index: 0 });
    await live.submitAnswer(sessionId, questions[4].id, { option_index: 4 });
    await live.submitAnswer(sessionId, questions[5].id, { option_index: 2 });
    const done = await live.submitAnswer(sessionId, questions[6].id, { option_index: 3 });
    expect(done.status).toBe('completed');

    const written = async () => ({ progress: await readProgress(t.db, E), snapshot: await readSnapshot(t.db, sessionId) });
    const before = await written();
    const level = (senseId: string, dimension: string) =>
      before.progress.find((row) => row.senseId === senseId && row.dimension === dimension)!.level;
    expect(level(words[0].senseId, 'spoken_receptive')).toBe(2);
    expect(level(words[1].senseId, 'written_productive')).toBe(2);
    expect(level(words[1].senseId, 'spelling')).toBe(1);
    expect(level(words[2].senseId, 'spoken_receptive')).toBe(2);
    expect(level(words[2].senseId, 'spelling')).toBe(2);
    expect(level(words[3].senseId, 'written_receptive')).toBe(2);
    expect(level(words[4].senseId, 'written_receptive')).toBe(1);

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
      words.push({ senseId: saved.senseIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation });
    }
    const { sessionId, questions } = await insertListSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      asked: words,
      types: ['read_aloud', 'say_translation', 'say_translation'],
    });

    await live.submitAnswer(sessionId, questions[0].id, { heard: 'tome' });
    await live.submitAnswer(sessionId, questions[1].id, { pass: 'show_answer' });
    const done = await live.submitAnswer(sessionId, questions[2].id, { text: 'lantern' });
    expect(done.status).toBe('completed');

    const written = async () => ({ progress: await readProgress(t.db, E), snapshot: await readSnapshot(t.db, sessionId) });
    const before = await written();
    const level = (senseId: string, dimension: string) =>
      before.progress.find((row) => row.senseId === senseId && row.dimension === dimension)!.level;
    expect(level(words[0].senseId, 'spoken_productive')).toBe(2);
    expect(level(words[2].senseId, 'written_productive')).toBe(2);
    expect(before.snapshot.length).toBeGreaterThan(0);

    expect(await recomputeProgress(t.db)).toEqual({ sessions: 1 });
    expect(await written()).toEqual(before);
  });
});
