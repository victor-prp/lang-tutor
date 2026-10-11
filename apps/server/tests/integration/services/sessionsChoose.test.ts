import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PgBoss } from 'pg-boss';

import { PREPARE_SESSION, type PrepareSessionPayload } from '../../../src/domain/jobs';
import { createFakeLogger } from '../../support/fakes';
import { jobPayloads, startTestBoss, stopTestBoss } from '../../support/jobs';
import { insertGlossMemory } from '../../support/progressRows';
import { insertListSession } from '../../support/questions';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

// Phase 35 (spec D5, D10). A list session is chosen from what the learner knows,
// on the learner's day: a second session the same day asks other words first.

const E = enrollmentOf('u_1');
const DAY = '2026-03-04';
const DAY_MS = 86_400_000;
let t: TestDb;
let boss: PgBoss;
let clock: number;

beforeEach(async () => {
  t = await createTestDb();
  boss = await startTestBoss(t.db);
  await seedUser(t.db, 'u_1');
  clock = Date.parse(`${DAY}T10:00:00Z`);
});
afterEach(async () => {
  await stopTestBoss(boss);
  await t.close();
});

const sessions = () =>
  createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7), now: () => clock, boss }).sessions;

type Word = { glossId: string; variantId: string; lexemeId: string; form: string; lemma: string; translation: string };

const LEMMAS = ['apple', 'bread', 'cheese', 'dates', 'eggs', 'flour', 'grapes', 'honey', 'jam', 'kale', 'lemon', 'mango'];
const HEBREW = ['תפוח', 'לחם', 'גבינה', 'תמרים', 'ביצים', 'קמח', 'ענבים', 'דבש', 'ריבה', 'כרוב', 'לימון', 'מנגו'];

async function savedWords(count = LEMMAS.length): Promise<Word[]> {
  const words: Word[] = [];
  for (const [i, lemma] of LEMMAS.slice(0, count).entries()) {
    const saved = await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [HEBREW[i]] });
    words.push({ glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation: HEBREW[i] });
  }
  return words;
}

/** A multiple-choice session over `words`, every card answered right: it completes. */
async function playRight(words: Word[]) {
  const service = sessions();
  const { sessionId, questions } = await insertListSession(t.db, {
    userId: 'u_1',
    enrollmentId: E,
    asked: words,
    types: words.map(() => 'multiple_choice' as const),
  });
  for (const question of questions) {
    const q = question as unknown as { id: string; correct_option: number };
    await service.submitAnswer('u_1', sessionId, q.id, { option_index: q.correct_option });
  }
}

async function nextPicks(): Promise<PrepareSessionPayload['picks']> {
  const service = sessions();
  const created = await service.createNextSession('u_1', E, { listening: false, speaking: false });
  const payloads = (await jobPayloads(t.db, PREPARE_SESSION)) as PrepareSessionPayload[];
  await service.skipSession('u_1', created.sessionId);
  return payloads[payloads.length - 1].picks;
}

describe('createNextSession chooses the words (spec D5)', () => {
  it('asks the words not asked today first, and the ones asked today last, even when due', async () => {
    const words = await savedWords(8);
    // A month ago, words 0 to 5 were met in both written dimensions: all are due now,
    // written receptive the weaker.
    const monthAgo = '2026-02-02';
    await insertGlossMemory(
      t.db,
      words.slice(0, 6).flatMap((word) =>
        (['written_receptive', 'written_productive'] as const).map((dimension) => ({
          enrollmentId: E,
          glossId: word.glossId,
          dimension,
          stability: dimension === 'written_receptive' ? 1 : 2,
          difficulty: 5,
          lastDay: monthAgo,
          reps: 1,
          lapses: 0,
          params: 'fsrs6-default',
        })),
      ),
    );
    // Today, words 0 to 3 were asked by multiple choice: written receptive only.
    await playRight(words.slice(0, 4));

    const picks = await nextPicks();
    const ids = (from: Word[]) => from.map((word) => word.glossId).sort();
    expect(picks).toHaveLength(8);
    // Due and not asked today (4, 5), then new (6, 7)...
    expect(picks.slice(0, 2).map((pick) => pick.gloss_id).sort()).toEqual(ids(words.slice(4, 6)));
    for (const pick of picks.slice(0, 2)) expect(pick).toMatchObject({ dimension: 'written_receptive', rung: 1, level: 1 });
    expect(picks.slice(2, 4).map((pick) => pick.gloss_id)).toEqual([words[7].glossId, words[6].glossId]);
    for (const pick of picks.slice(2, 4)) expect(pick).toMatchObject({ dimension: 'written_receptive', rung: 1, level: 1, r: null });
    // ...and last, the words asked today, whose written productive is still due.
    expect(picks.slice(4).map((pick) => pick.gloss_id).sort()).toEqual(ids(words.slice(0, 4)));
    for (const pick of picks.slice(4)) {
      expect(pick.dimension).toBe('written_productive');
      expect(pick.r).toBeLessThan(0.9);
    }
  });

  it('on the next day, expands the words introduced yesterday into their next dimension', async () => {
    const words = await savedWords();
    await playRight(words.slice(0, 10));
    clock += DAY_MS;

    const picks = await nextPicks();
    expect(picks).toHaveLength(10);
    const yesterday = new Set(words.slice(0, 10).map((word) => word.glossId));
    const expanded = picks.filter((pick) => yesterday.has(pick.gloss_id));
    expect(expanded.length).toBeGreaterThan(0);
    // A right multiple choice is written-receptive evidence only: the next in ORDER is written productive.
    for (const pick of expanded) expect(pick).toMatchObject({ dimension: 'written_productive', rung: 1, r: null });
  });
});
