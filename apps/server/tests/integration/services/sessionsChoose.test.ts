import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import { LADDER_SLOTS } from '../../../src/domain/chooseConstants';
import { sessions as sessionsTable } from '../../../src/db/schema';
import { PREPARE_SESSION, type PrepareSessionPayload } from '../../../src/domain/jobs';
import { createFakeLogger } from '../../support/fakes';
import { jobPayloads, startTestBoss, stopTestBoss } from '../../support/jobs';
import { insertGlossMemory } from '../../support/progressRows';
import { insertListSession } from '../../support/questions';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedUser, setNewWordLimits } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

// Phase 35 (spec D5, D10), phase 37 (D1, D3). A list session is chosen from what
// the learner knows, on the learner's day: a second session the same day brings
// back what the first missed, and asks words already done that day last.

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

/** A multiple-choice session over `words`, every card answered, right unless
 *  `wrong` names its word: it completes. */
async function play(words: Word[], wrong: Word[] = []) {
  const service = sessions();
  const { sessionId, questions } = await insertListSession(t.db, {
    userId: 'u_1',
    enrollmentId: E,
    asked: words,
    types: words.map(() => 'multiple_choice' as const),
  });
  for (const [i, question] of questions.entries()) {
    const q = question as unknown as { id: string; correct_option: number };
    const option = wrong.includes(words[i]) ? (q.correct_option + 1) % 4 : q.correct_option;
    await service.submitAnswer('u_1', sessionId, q.id, { option_index: option });
  }
}
const playRight = (words: Word[]) => play(words);

async function nextPicks(): Promise<PrepareSessionPayload['picks']> {
  const service = sessions();
  const created = await service.createNextSession('u_1', E, { listening: false, speaking: false });
  const payloads = (await jobPayloads(t.db, PREPARE_SESSION)) as PrepareSessionPayload[];
  await service.skipSession('u_1', created.sessionId);
  return payloads[payloads.length - 1].picks;
}

describe('createNextSession chooses the words (spec D5)', () => {
  it('brings back the word missed today as a recall card, after the new words and before the due ones, and asks the words done today last', async () => {
    const words = await savedWords(8);
    // A month ago, words 0 to 5 were met: their written receptive is due now.
    const today = clock;
    clock = Date.parse('2026-02-02T10:00:00Z');
    await playRight(words.slice(0, 6));
    clock = today;
    // Today, words 0 to 3 were asked again, and word 2 was missed.
    await play(words.slice(0, 4), [words[2]]);

    const picks = await nextPicks();
    const ids = (from: Word[]) => from.map((word) => word.glossId).sort();
    // Phase 55 (spec D4): the new words are ladders, four slots each. The return and the two due
    // words leave room for one; the second does not fit the three slots left, and the three words
    // answered today fill them.
    expect(picks).toHaveLength(7);
    // The new word (the reserve), the newest...
    expect(picks[0]).toMatchObject({ gloss_id: words[7].glossId, dimension: 'written_receptive', rung: 1, r: null, step: false });
    // ...the missed word, owed a return: recall, though met a month ago...
    expect(picks[1]).toMatchObject({ gloss_id: words[2].glossId, dimension: 'written_receptive', rung: 2, r: 1, step: true });
    // ...the words due and not asked today...
    expect(picks.slice(2, 4).map((pick) => pick.gloss_id).sort()).toEqual(ids(words.slice(4, 6)));
    for (const pick of picks.slice(2, 4)) {
      expect(pick).toMatchObject({ dimension: 'written_receptive', rung: 1, step: false });
      expect(pick.r).toBeLessThan(0.75);
    }
    // ...and last the words answered right today, each in the dimension it would expand into.
    expect(picks.slice(4).map((pick) => pick.gloss_id).sort()).toEqual(ids([words[0], words[1], words[3]]));
    for (const pick of picks.slice(4)) expect(pick).toMatchObject({ dimension: 'written_productive', rung: 1, r: null, step: false });
  });

  it('on the next day, expands the words introduced yesterday into their next dimension', async () => {
    const words = await savedWords();
    await playRight(words.slice(0, 10));
    clock += DAY_MS;

    const picks = await nextPicks();
    // Phase 55 (spec D4): the two words never met are ladders, four slots each.
    expect(picks).toHaveLength(10 - 2 * LADDER_SLOTS + 2);
    const yesterday = new Set(words.slice(0, 10).map((word) => word.glossId));
    const expanded = picks.filter((pick) => yesterday.has(pick.gloss_id));
    expect(expanded.length).toBeGreaterThan(0);
    // A right multiple choice is written-receptive evidence only: the next in ORDER is written productive.
    for (const pick of expanded) expect(pick).toMatchObject({ dimension: 'written_productive', rung: 1, r: null });
  });
});

// Phase 70 (spec D2, D4, D5). The learner's cap steers the choice, and a session records the new
// words it held back, which its view reports while that is still news.
describe("the learner's daily cap (phase 70)", () => {
  const held = async (sessionId: string) => {
    const [row] = await t.db
      .select({ count: sessionsTable.newWordsHeld, dayCap: sessionsTable.dayNewCap })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId));
    return row;
  };
  const stock = () => sessions().createNextSession('u_1', E, { listening: false, speaking: false });
  const lastPicks = async () => ((await jobPayloads(t.db, PREPARE_SESSION)) as PrepareSessionPayload[]).at(-1)!.picks;

  it('a stock chosen once the cap is spent asks no new word and records the words it held back', async () => {
    const words = await savedWords(4);
    await setNewWordLimits(t.db, 'u_1', { dayNewCap: 1, newPerSession: null });
    await playRight(words.slice(0, 1));

    const created = await stock();
    expect((await lastPicks()).filter((pick) => pick.ladder)).toEqual([]);
    // With no cap the session would have met two: phase 55's two ladders.
    expect(await held(created.sessionId)).toEqual({ count: 2, dayCap: 1 });
  });

  it('a raised cap reaches the next stock: it meets new words, and holds none back', async () => {
    const words = await savedWords(4);
    await setNewWordLimits(t.db, 'u_1', { dayNewCap: 1, newPerSession: null });
    await playRight(words.slice(0, 1));
    const spent = await stock();
    await sessions().skipSession('u_1', spent.sessionId);

    await setNewWordLimits(t.db, 'u_1', { dayNewCap: 30, newPerSession: null });
    const raised = await stock();
    expect((await lastPicks()).filter((pick) => pick.ladder).length).toBeGreaterThan(0);
    expect(await held(raised.sessionId)).toEqual({ count: 0, dayCap: 30 });
  });

  it('per session 2 meets two new words where automatic meets one against a backlog', async () => {
    const words = await savedWords(12);
    await playRight(words.slice(0, 10));
    clock += 30 * DAY_MS;
    await setNewWordLimits(t.db, 'u_1', { dayNewCap: null, newPerSession: 2 });
    await stock();
    expect((await lastPicks()).filter((pick) => pick.ladder)).toHaveLength(2);
  });

  it('the session view reports the words held back only on the day and under the cap they were chosen', async () => {
    const words = await savedWords(4);
    await setNewWordLimits(t.db, 'u_1', { dayNewCap: 1, newPerSession: null });
    await playRight(words.slice(0, 1));
    const created = await stock();

    expect((await sessions().getSession('u_1', created.sessionId)).held_new_words).toEqual({ count: 2, day_cap: 1 });
    // The learner raised the cap since: the message would quote a cap that no longer holds.
    await setNewWordLimits(t.db, 'u_1', { dayNewCap: 30, newPerSession: null });
    expect((await sessions().getSession('u_1', created.sessionId)).held_new_words).toBeUndefined();
    // Back to the cap it was chosen under, on the next day: a day whose cap is untouched.
    await setNewWordLimits(t.db, 'u_1', { dayNewCap: 1, newPerSession: null });
    clock += DAY_MS;
    expect((await sessions().getSession('u_1', created.sessionId)).held_new_words).toBeUndefined();
  });

  it('a session the cap did not touch reports nothing', async () => {
    const words = await savedWords(4);
    await playRight(words.slice(0, 1));
    const created = await stock();
    expect(await held(created.sessionId)).toEqual({ count: 0, dayCap: 15 });
    expect((await sessions().getSession('u_1', created.sessionId)).held_new_words).toBeUndefined();
  });
});
