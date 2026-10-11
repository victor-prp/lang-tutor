import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { review } from '@lang-tutor/core/domain';
import { eq } from 'drizzle-orm';

import { glossMemory } from '../../../src/db/schema';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger } from '../../support/fakes';
import { failInsertsInto, readProgress } from '../../support/progressRows';
import { insertListSession } from '../../support/questions';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

// Phase 35 (spec D4). Ending a session writes the hidden memory in the same
// transaction as the levels.

const E = enrollmentOf('u_1');
const DAY_1 = '2026-03-04';
let t: TestDb;
let clock: number;

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  clock = Date.parse(`${DAY_1}T10:00:00Z`);
});
afterEach(async () => {
  await t.close();
});

const live = () =>
  createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7), now: () => clock }).sessions;

type Word = { glossId: string; variantId: string; lexemeId: string; form: string; lemma: string; translation: string };

async function savedWord(lemma: string, translation: string): Promise<Word> {
  const saved = await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [translation] });
  return { glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation };
}

async function unsavedWord(lemma: string, translation: string): Promise<Word> {
  const word = await insertLexeme(t.db, {
    lemma,
    languageCode: 'en',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'x' }],
    variants: [
      {
        form: lemma,
        kind: 'word',
        entryRank: 0,
        translations: [{ senseCode: 'x', rank: 0, translation, exampleSource: null, exampleTarget: null }],
      },
    ],
  });
  return { glossId: word.glossIds[0], variantId: word.variantIds[0], lexemeId: word.lexemeId, form: lemma, lemma, translation };
}

/** A session of multiple-choice cards, each answered right or wrong. */
async function play(words: Word[], right: boolean[]) {
  const service = live();
  const { sessionId, questions } = await insertListSession(t.db, {
    userId: 'u_1',
    enrollmentId: E,
    asked: words,
    types: words.map(() => 'multiple_choice' as const),
  });
  let last;
  for (const [i, question] of questions.entries()) {
    const q = question as unknown as { id: string; correct_option: number; options: unknown[] };
    last = await service.submitAnswer('u_1', sessionId, q.id, {
      option_index: right[i] ? q.correct_option : (q.correct_option + 1) % q.options.length,
    });
  }
  return { sessionId, last };
}

// The columns are `real` (float32), so a stored number is the model's to about seven digits.
const f32 = (x: number) => expect.closeTo(x, 4);

const memoryOf = (glossId: string) =>
  t.db.select().from(glossMemory).where(eq(glossMemory.glossId, glossId));

describe('memory written when a session ends', () => {
  it('writes rows for saved glosses only', async () => {
    const saved = await savedWord('tome', 'ספר');
    const stranger = await unsavedWord('orchard', 'פרדס');
    const { last } = await play([saved, stranger], [true, true]);
    expect(last!.status).toBe('completed');

    const rows = await memoryOf(saved.glossId);
    expect(rows).toHaveLength(1);
    const expected = review(null, 3, DAY_1);
    expect(rows[0]).toMatchObject({
      enrollmentId: E,
      dimension: 'written_receptive',
      stability: f32(expected.stability),
      difficulty: f32(expected.difficulty),
      lastDay: DAY_1,
      reps: 1,
      lapses: 0,
      params: expected.params,
    });
    expect(await memoryOf(stranger.glossId)).toEqual([]);
  });

  it('rolls levels and memory back together when the memory write fails', async () => {
    const saved = await savedWord('tome', 'ספר');
    const levelsBefore = await readProgress(t.db, E);
    await failInsertsInto(t.db, 'gloss_memory');

    await expect(play([saved], [true])).rejects.toThrow();

    expect(await memoryOf(saved.glossId)).toEqual([]);
    expect(await readProgress(t.db, E)).toEqual(levelsBefore);
  });

  it('takes the long-term rule for the day\'s first review and t = 0 for the second session of that day', async () => {
    const saved = await savedWord('tome', 'ספר');
    await play([saved], [true]);
    const first = review(null, 3, DAY_1);
    expect((await memoryOf(saved.glossId))[0]).toMatchObject({ stability: f32(first.stability), reps: 1 });

    clock += 3_600_000; // the same UTC day
    await play([saved], [true]);
    const sameDay = review(first, 3, DAY_1);
    const afterSecond = (await memoryOf(saved.glossId))[0];
    expect(afterSecond).toMatchObject({ stability: f32(sameDay.stability), difficulty: f32(sameDay.difficulty), reps: 2, lastDay: DAY_1 });

    // The next day it is a long-term review again, not t = 0.
    clock += 24 * 3_600_000;
    await play([saved], [true]);
    const nextDay = review(sameDay, 3, '2026-03-05');
    const afterThird = (await memoryOf(saved.glossId))[0];
    expect(afterThird).toMatchObject({ stability: f32(nextDay.stability), reps: 3, lastDay: '2026-03-05' });
    expect(nextDay.stability).not.toBe(review(sameDay, 3, DAY_1).stability);
  });

  it('counts a wrong answer as a lapse', async () => {
    const saved = await savedWord('tome', 'ספר');
    await play([saved], [false]);
    expect((await memoryOf(saved.glossId))[0]).toMatchObject({ reps: 1, lapses: 1 });
  });
});
