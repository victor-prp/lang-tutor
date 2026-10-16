import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { AnswerInput, QuestionType } from '@lang-tutor/core/domain';

import { createFakeLogger } from '../../support/fakes';
import { failInsertsInto, readMemory, readProgress } from '../../support/progressRows';
import { asChoice, insertListSession, type AskedGloss } from '../../support/questions';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, makeBot, seedUser } from '../../support/seedUser';
import { endTargetNow, readStartedOn, readTargetSkillEvents, readTargetSkills, seedTarget } from '../../support/targetRows';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

// Phase 57 (spec D3, D4, D10). An ended session moves the target skills of every target active
// on its day that holds a word it asked, each against its own cap, in the transaction of the
// levels and the memory. The learner is a bot, so the day is the profile's (ADR 0013) and
// moves only when a test moves it, while every instant is the real clock's.

const E = enrollmentOf('u_1');
const DAY_1 = '2030-01-08';
const DAY_2 = '2030-01-09';
const LIVE_DIMS = ['spelling', 'written_productive', 'written_receptive'];

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  await makeBot(t.db, 'u_1', DAY_1);
});
afterEach(async () => {
  await t.close();
});

const live = () => createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) }).sessions;

async function savedWord(lemma: string, translation: string): Promise<AskedGloss> {
  const saved = await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [translation] });
  return { glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation };
}

/** A target of `glossIds` due on `dueOn`, set up directly: the targets service is not this test's. */
const addTarget = (dueOn: string, words: AskedGloss[]) =>
  seedTarget(t.db, { enrollmentId: E, kind: 'exam', dueOn, glossIds: words.map((word) => word.glossId) });

type Card = { word: AskedGloss; type: QuestionType; right?: boolean; helped?: boolean };

/** A ready session of `cards`. `answer(i)` answers card i: a choice by its option, a typed card
 *  with its word (or a wrong word), helped when the card says so. */
async function session(cards: Card[]) {
  const service = live();
  const { sessionId, questions } = await insertListSession(t.db, {
    userId: 'u_1',
    enrollmentId: E,
    asked: cards.map((card) => card.word),
    types: cards.map((card) => card.type),
  });
  const answer = (i: number) => {
    const { word, type, right = true, helped } = cards[i];
    let input: AnswerInput;
    if (type === 'multiple_choice') {
      const q = asChoice(questions[i]);
      input = { option_index: right ? q.correct_option : (q.correct_option + 1) % q.options.length };
    } else {
      input = { text: right ? word.form : 'zzzz', ...(helped ? { helped: true } : {}) };
    }
    return service.submitAnswer('u_1', sessionId, questions[i].id, input);
  };
  const answerAll = async () => {
    let last;
    for (let i = 0; i < cards.length; i++) last = await answer(i);
    return last!;
  };
  return { sessionId, answer, answerAll, skip: () => service.skipSession('u_1', sessionId) };
}

const halvesOf = async (targetId: string) =>
  Object.fromEntries((await readTargetSkills(t.db, targetId)).map((row) => [`${row.glossId}:${row.dimension}`, row.halves]));

describe('target skills at session end (spec D4)', () => {
  it('writes the skills a completed session moved, one event per change, beside the memory', async () => {
    const tome = await savedWord('tome', 'ספר');
    const quill = await savedWord('quill', 'נוצה');
    const exam = await addTarget('2030-01-11', [tome]); // three days left: cap 10
    const play = await session([
      { word: tome, type: 'typed_translation' },
      { word: tome, type: 'multiple_choice' },
      { word: quill, type: 'multiple_choice' },
    ]);
    expect((await play.answerAll()).status).toBe('completed');

    const skills = await readTargetSkills(t.db, exam);
    expect(skills).toEqual(
      LIVE_DIMS.map((dimension) => ({ glossId: tome.glossId, dimension, halves: 4, sessionId: play.sessionId, day: DAY_1 })),
    );
    expect(await readTargetSkillEvents(t.db, exam)).toEqual(
      LIVE_DIMS.map((dimension) => ({ glossId: tome.glossId, dimension, sessionId: play.sessionId, before: 0, after: 4, why: 'recall' })),
    );
    expect(await readStartedOn(t.db, exam)).toEqual({ [tome.glossId]: DAY_1 });
    // The main write is as it was: both words' memory.
    expect(new Set((await readMemory(t.db, E)).map((row) => row.glossId))).toEqual(new Set([tome.glossId, quill.glossId]));
  });

  it('rolls the levels, the memory and the target skills back together when the target write fails', async () => {
    const tome = await savedWord('tome', 'ספר');
    const exam = await addTarget('2030-01-11', [tome]);
    const levelsBefore = await readProgress(t.db, E);
    await failInsertsInto(t.db, 'target_skill_events');

    const play = await session([{ word: tome, type: 'typed_translation' }]);
    await expect(play.answer(0)).rejects.toThrow();

    expect(await readTargetSkills(t.db, exam)).toEqual([]);
    expect(await readStartedOn(t.db, exam)).toEqual({ [tome.glossId]: null });
    expect(await readMemory(t.db, E)).toEqual([]);
    expect(await readProgress(t.db, E)).toEqual(levelsBefore);
  });

  it('writes no target skill when the memory write fails', async () => {
    const tome = await savedWord('tome', 'ספר');
    const exam = await addTarget('2030-01-11', [tome]);
    await failInsertsInto(t.db, 'gloss_memory');

    const play = await session([{ word: tome, type: 'typed_translation' }]);
    await expect(play.answer(0)).rejects.toThrow();

    expect(await readTargetSkills(t.db, exam)).toEqual([]);
    expect(await readTargetSkillEvents(t.db, exam)).toEqual([]);
    expect(await readStartedOn(t.db, exam)).toEqual({ [tome.glossId]: null });
  });

  it('moves a gloss in two active targets, each against its own cap', async () => {
    const tome = await savedWord('tome', 'ספר');
    const soon = await addTarget('2030-01-09', [tome]); // one day left: cap 20
    const far = await addTarget('2030-02-20', [tome]); // past the table: cap 2
    await (await session([{ word: tome, type: 'typed_translation' }])).answerAll();

    expect(Object.values(await halvesOf(soon))).toEqual([4, 4, 4]);
    expect(Object.values(await halvesOf(far))).toEqual([2, 2, 2]);
  });

  it('moves a target through its due date, and none past it or ended before the answers (spec D10)', async () => {
    const tome = await savedWord('tome', 'ספר');
    const due = await addTarget(DAY_1, [tome]);
    const past = await addTarget('2030-01-07', [tome]);
    const ended = await addTarget('2030-01-11', [tome]);
    await endTargetNow(t.db, ended);
    await (await session([{ word: tome, type: 'typed_translation' }])).answerAll();

    expect(Object.values(await halvesOf(due))).toEqual([4, 4, 4]);
    expect(await readTargetSkills(t.db, past)).toEqual([]);
    expect(await readTargetSkills(t.db, ended)).toEqual([]);
    expect(await readStartedOn(t.db, past)).toEqual({ [tome.glossId]: null });
    expect(await readStartedOn(t.db, ended)).toEqual({ [tome.glossId]: null });
  });

  it('counts for nothing an answer given before the word joined the target', async () => {
    const tome = await savedWord('tome', 'ספר');
    const quill = await savedWord('quill', 'נוצה');
    const play = await session([
      { word: tome, type: 'typed_translation' },
      { word: quill, type: 'multiple_choice' },
      { word: tome, type: 'multiple_choice' },
    ]);
    await play.answer(0); // a recall, before the target holds tome
    const exam = await addTarget('2030-01-11', [tome, quill]);
    await play.answer(1);
    expect((await play.answer(2)).status).toBe('completed');

    // Recognition only for tome: its typed recall came before it joined.
    expect(await halvesOf(exam)).toEqual({
      [`${quill.glossId}:written_receptive`]: 2,
      [`${tome.glossId}:written_receptive`]: 2,
    });
  });

  it('starts a word on the first session that asks it, a helped answer too, and never moves the day', async () => {
    const tome = await savedWord('tome', 'ספר');
    const quill = await savedWord('quill', 'נוצה');
    const exam = await addTarget('2030-01-11', [tome, quill]);

    await (await session([{ word: tome, type: 'typed_translation', helped: true }])).answerAll();
    expect(await readStartedOn(t.db, exam)).toEqual({ [tome.glossId]: DAY_1, [quill.glossId]: null });
    // A helped answer moves no target value; the main skills still grade it wrong, which
    // reaches written_productive alone (a right typed answer would reach three).
    expect(await readTargetSkills(t.db, exam)).toEqual([]);
    expect((await readMemory(t.db, E)).map((row) => row.dimension)).toEqual(['written_productive']);

    await makeBot(t.db, 'u_1', DAY_2);
    await (
      await session([
        { word: tome, type: 'typed_translation' },
        { word: quill, type: 'typed_translation' },
      ])
    ).answerAll();
    expect(await readStartedOn(t.db, exam)).toEqual({ [tome.glossId]: DAY_1, [quill.glossId]: DAY_2 });
  });

  it('writes on a skip as on a completion, from the answers given before it', async () => {
    const tome = await savedWord('tome', 'ספר');
    const quill = await savedWord('quill', 'נוצה');
    const exam = await addTarget('2030-01-11', [tome, quill]);
    const play = await session([
      { word: tome, type: 'typed_translation' },
      { word: quill, type: 'multiple_choice' },
    ]);
    await play.answer(0);
    await play.skip();

    expect(await readTargetSkills(t.db, exam)).toEqual(
      LIVE_DIMS.map((dimension) => ({ glossId: tome.glossId, dimension, halves: 4, sessionId: play.sessionId, day: DAY_1 })),
    );
    expect(await readTargetSkillEvents(t.db, exam)).toHaveLength(3);
    expect(await readStartedOn(t.db, exam)).toEqual({ [tome.glossId]: DAY_1, [quill.glossId]: null });
  });

  it('takes a miss off a skill and logs why', async () => {
    const tome = await savedWord('tome', 'ספר');
    const exam = await addTarget('2030-01-09', [tome]); // cap 20
    await (await session([{ word: tome, type: 'typed_translation' }])).answerAll();
    await makeBot(t.db, 'u_1', DAY_2); // the due date: cap 20
    const second = await session([{ word: tome, type: 'typed_translation', right: false }]);
    await second.answerAll();

    expect(await halvesOf(exam)).toEqual({
      [`${tome.glossId}:spelling`]: 4,
      [`${tome.glossId}:written_productive`]: 0,
      [`${tome.glossId}:written_receptive`]: 4,
    });
    expect((await readTargetSkillEvents(t.db, exam)).filter((event) => event.sessionId === second.sessionId)).toEqual([
      { glossId: tome.glossId, dimension: 'written_productive', sessionId: second.sessionId, before: 4, after: 0, why: 'miss' },
    ]);
  });
});
