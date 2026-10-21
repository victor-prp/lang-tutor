import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createDiscoveryRepo } from '../../../src/repo/discovery';
import { createVocabularyRepo } from '../../../src/repo/vocabulary';
import { seedDiscoveryRun } from '../../support/discoveryRows';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { seedSavedSenses } from '../../support/vocabularyRows';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;
const E = enrollmentOf('u_1');
const repo = <T>(run: (r: ReturnType<typeof createDiscoveryRepo>) => Promise<T>) =>
  withTx(t.db, (tx) => run(createDiscoveryRepo(tx)));

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
});
afterEach(async () => {
  await t.close();
});

const card = (position: number, word: string, round = 1) => ({
  position,
  round,
  level: 3,
  word,
  partOfSpeech: 'noun' as const,
  hebrew: 'משהו',
  alternatives: ['עוד'],
});
const answerOf = (answer: 'unknown' | 'typed', known: boolean, at = new Date('2026-10-21T10:00:00Z')) => ({
  answer,
  typedText: answer === 'typed' ? 'משהו' : null,
  verdict: answer === 'typed' ? ('exact' as const) : null,
  known,
  judgedBy: answer === 'typed' ? ('rule' as const) : null,
  lookupStatus: known ? null : ('pending' as const),
  answeredAt: at,
});
const option = { gloss_id: 'g1', variant_id: 'v1', translation: 'משהו' };
const ready = { correctedForm: null, options: [option], chosenGlossId: 'g1', ticked: true, hebrewMismatch: false, reason: null };

describe('discovery repository (phase 69, spec D9)', () => {
  it('writes a profile once and moves its level', async () => {
    const input = { enrollmentId: E, selfLevel: 'simple' as const, learningContext: 'school' as const, level: 3 };
    expect(await repo((r) => r.insertProfile(input))).toMatchObject(input);
    expect(await repo((r) => r.insertProfile({ ...input, level: 9 }))).toBeUndefined();
    await repo((r) => r.setLevel(E, 5));
    expect(await repo((r) => r.findProfile(E))).toMatchObject({ level: 5, selfLevel: 'simple' });
  });

  it('holds one open run per enrollment; a saved one does not block a new one', async () => {
    const first = await repo((r) => r.insertRun({ enrollmentId: E, goal: 15 }));
    expect(first).toMatchObject({ enrollmentId: E, goal: 15, status: 'asking', settledRound: 0, endedAt: null });
    expect(await repo((r) => r.insertRun({ enrollmentId: E, goal: 5 }))).toBeUndefined();
    expect(await repo((r) => r.findOpenRun(E))).toMatchObject({ id: first!.id });

    expect(await repo((r) => r.transition(first!.id, ['asking'], 'listing'))).toBe(true);
    expect(await repo((r) => r.insertRun({ enrollmentId: E, goal: 5 }))).toBeUndefined();
    expect(await repo((r) => r.transition(first!.id, ['listing'], 'saved'))).toBe(true);
    expect(await repo((r) => r.insertRun({ enrollmentId: E, goal: 5 }))).toMatchObject({ goal: 5 });
  });

  it('moves a run only from the statuses given, and stamps when it leaves asking', async () => {
    const run = (await repo((r) => r.insertRun({ enrollmentId: E, goal: 15 })))!;
    expect(await repo((r) => r.transition(run.id, ['listing'], 'saved'))).toBe(false);
    expect((await repo((r) => r.findRun(run.id)))?.endedAt).toBeNull();
    expect(await repo((r) => r.transition(run.id, ['asking'], 'listing'))).toBe(true);
    expect((await repo((r) => r.findRunForUpdate(run.id)))?.endedAt).toBeInstanceOf(Date);
    await repo((r) => r.setSettledRound(run.id, 2));
    expect(await repo((r) => r.findRun(run.id))).toMatchObject({ status: 'listing', settledRound: 2 });
  });

  it('answers undefined, not an error, for an id that is not a uuid', async () => {
    expect(await repo((r) => r.findRun('nope'))).toBeUndefined();
    expect(await repo((r) => r.findRunForUpdate('nope'))).toBeUndefined();
    expect(await repo((r) => r.listCards('nope'))).toEqual([]);
  });

  it('answers a card once, and writes a lookup only on a pending card', async () => {
    const run = (await repo((r) => r.insertRun({ enrollmentId: E, goal: 15 })))!;
    await repo((r) => r.insertCards(run.id, [card(0, 'gatto'), card(1, 'cane')]));
    expect(await repo((r) => r.answerCard(run.id, 0, answerOf('unknown', false)))).toBe(true);
    expect(await repo((r) => r.answerCard(run.id, 0, answerOf('typed', true)))).toBe(false);
    expect(await repo((r) => r.answerCard(run.id, 1, answerOf('typed', true)))).toBe(true);

    expect(await repo((r) => r.writeLookup(run.id, 1, ready))).toBe(false);
    expect(await repo((r) => r.writeLookup(run.id, 0, ready))).toBe(true);
    expect(await repo((r) => r.writeLookup(run.id, 0, ready))).toBe(false);
    expect(await repo((r) => r.markLookupFailed(run.id, 0))).toBe(false);

    const cards = await repo((r) => r.listCards(run.id));
    expect(cards.map((c) => c.position)).toEqual([0, 1]);
    expect(cards[0]).toMatchObject({
      word: 'gatto',
      answer: 'unknown',
      known: false,
      lookupStatus: 'ready',
      options: [option],
      suggestedGlossId: 'g1',
      chosenGlossId: 'g1',
      ticked: true,
      alternatives: ['עוד'],
    });
    expect(cards[1]).toMatchObject({ answer: 'typed', typedText: 'משהו', verdict: 'exact', known: true, judgedBy: 'rule', lookupStatus: null });
  });

  it('marks a pending lookup failed, unticked', async () => {
    const run = (await repo((r) => r.insertRun({ enrollmentId: E, goal: 15 })))!;
    await repo((r) => r.insertCards(run.id, [card(0, 'gatto')]));
    await repo((r) => r.answerCard(run.id, 0, answerOf('unknown', false)));
    expect(await repo((r) => r.markLookupFailed(run.id, 0))).toBe(true);
    expect((await repo((r) => r.listCards(run.id)))[0]).toMatchObject({ lookupStatus: 'failed', ticked: false });
  });

  it("changes a row's tick and gloss", async () => {
    const run = (await repo((r) => r.insertRun({ enrollmentId: E, goal: 15 })))!;
    await repo((r) => r.insertCards(run.id, [card(0, 'gatto')]));
    await repo((r) => r.answerCard(run.id, 0, answerOf('unknown', false)));
    await repo((r) => r.writeLookup(run.id, 0, ready));
    expect(await repo((r) => r.updateItem(run.id, 0, { ticked: false }))).toMatchObject({ ticked: false, chosenGlossId: 'g1' });
    expect(await repo((r) => r.updateItem(run.id, 3, { ticked: false }))).toBeUndefined();
  });

  it("lists the words a learner answered in any run, newest answer first, not the ones never shown", async () => {
    const old = await seedDiscoveryRun(t.db, {
      enrollmentId: E,
      status: 'saved',
      cards: [
        { word: 'gatto', answer: 'unknown', answeredAt: new Date('2026-10-20T10:00:00Z') },
        { word: 'mai', answer: null },
      ],
    });
    expect(old).toEqual(expect.any(String));
    await seedDiscoveryRun(t.db, {
      enrollmentId: E,
      status: 'asking',
      cards: [{ word: 'cane', answer: 'typed', known: true, answeredAt: new Date('2026-10-21T10:00:00Z') }],
    });
    expect(await repo((r) => r.answeredWords(E))).toEqual(['cane', 'gatto']);
  });

  it('removes the cards with their run', async () => {
    const id = await seedDiscoveryRun(t.db, { enrollmentId: E, status: 'saved', cards: [{ word: 'gatto', answer: null }] });
    await t.db.execute(sql`delete from discovery_runs where id = ${id}`);
    expect(await repo((r) => r.listCards(id))).toEqual([]);
  });

  it('refuses a goal over 30, a level over 12 and a tick without a gloss', async () => {
    await expect(repo((r) => r.insertRun({ enrollmentId: E, goal: 31 }))).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining('discovery_runs_goal_known') }),
    });
    await expect(
      repo((r) => r.insertProfile({ enrollmentId: E, selfLevel: 'none', learningContext: 'self', level: 13 })),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringContaining('discovery_profiles_level_known') }) });
    const run = (await repo((r) => r.insertRun({ enrollmentId: E, goal: 15 })))!;
    await repo((r) => r.insertCards(run.id, [card(0, 'gatto')]));
    await expect(t.db.execute(sql`update discovery_cards set ticked = true where run_id = ${run.id}`)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining('discovery_cards_tick_needs_gloss') }),
    });
  });
});

describe('vocabulary savedLemmas (phase 69, spec D4)', () => {
  it("lists the enrollment's saved lemmas once each, newest save first", async () => {
    await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'kite', translations: ['עפיפון', 'דיה'] });
    await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'cat', translations: ['חתול'] });
    expect(await withTx(t.db, (tx) => createVocabularyRepo(tx).savedLemmas(E))).toEqual(['cat', 'kite']);
  });
});
