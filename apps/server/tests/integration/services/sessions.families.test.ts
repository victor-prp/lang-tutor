import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { Dimension } from '@lang-tutor/core/domain';
import type { PgBoss } from 'pg-boss';

import { PREPARE_SESSION, type PrepareSessionPayload } from '../../../src/domain/jobs';
import { readFamilyEvents, readFamilyMembers } from '../../support/familyRows';
import { createFakeLogger } from '../../support/fakes';
import { jobPayloads, startTestBoss, stopTestBoss } from '../../support/jobs';
import { insertGlossMemory, setMemoryStability } from '../../support/progressRows';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

// Phase 39 (spec D4, D5). Creating a list session derives the gloss families from
// memory and the dictionary, records them in the same transaction, and keeps a
// waiting meaning out of the session.

const E = enrollmentOf('u_1');
const NOW = '2026-03-04T10:00:00.000Z';
const LIVE: Dimension[] = ['written_receptive', 'written_productive', 'spelling'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let t: TestDb;
let boss: PgBoss;

beforeEach(async () => {
  t = await createTestDb();
  boss = await startTestBoss(t.db);
  await seedUser(t.db, 'u_1');
});
afterEach(async () => {
  await stopTestBoss(boss);
  await t.close();
});

const sessions = () =>
  createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7), now: () => Date.parse(NOW), boss }).sessions;

/** Past the seed, `pick up` saved with two meanings (להרים the commoner), and two single words. */
async function savedFamily() {
  const service = sessions();
  const seed = await service.createNextSession('u_1', E, { listening: false, speaking: false });
  await service.skipSession('u_1', seed.sessionId);
  const pickUp = await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'pick up', translations: ['להרים', 'לאסוף'] });
  await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'apple', translations: ['תפוח'] });
  await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'bread', translations: ['לחם'] });
  const [lift, collect] = pickUp.glossIds;
  return { lift, collect };
}

/** Creates the next list session, and answers its id and its job's picks; the session is skipped. */
async function nextSession(): Promise<{ sessionId: string; picks: PrepareSessionPayload['picks'] }> {
  const service = sessions();
  const { sessionId } = await service.createNextSession('u_1', E, { listening: false, speaking: false });
  const payloads = (await jobPayloads(t.db, PREPARE_SESSION)) as PrepareSessionPayload[];
  await service.skipSession('u_1', sessionId);
  return { sessionId, picks: payloads.find((payload) => payload.session_id === sessionId)!.picks };
}

/** Known in every skill live with listening and speaking off. */
async function known(glossId: string) {
  await insertGlossMemory(
    t.db,
    LIVE.map((dimension) => ({
      enrollmentId: E,
      glossId,
      dimension,
      stability: 8,
      difficulty: 5,
      lastDay: '2026-03-01',
      reps: 2,
      lapses: 0,
      params: 'fsrs6-default',
    })),
  );
}

describe('createNextSession records the gloss families (phase 39 D4, D5)', () => {
  it('writes the family under an id the database made, its members and a joined event each, naming the session', async () => {
    const { lift, collect } = await savedFamily();
    const { sessionId } = await nextSession();

    const members = await readFamilyMembers(t.db, E);
    expect(members).toEqual([
      { familyId: expect.stringMatching(UUID), label: 'pick up', glossId: lift, state: 'current', position: 0, knownAt: null },
      { familyId: members[0].familyId, label: 'pick up', glossId: collect, state: 'waiting', position: 1, knownAt: null },
    ]);
    // One transaction's events share their time: their order is not asserted.
    const evidence = { live: LIVE, stability: {}, known_stability: 7 };
    const events = await readFamilyEvents(t.db, E);
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        { familyId: members[0].familyId, glossId: lift, sessionId, fromState: null, toState: 'current', evidence },
        { familyId: members[0].familyId, glossId: collect, sessionId, fromState: null, toState: 'waiting', evidence },
      ]),
    );
  });

  it('never picks a waiting gloss', async () => {
    const { lift, collect } = await savedFamily();
    const { picks } = await nextSession();
    const ids = picks.map((pick) => pick.gloss_id);
    expect(ids).toContain(lift);
    expect(ids).not.toContain(collect);
    expect(ids).toHaveLength(3);
  });

  it("introduces a never-asked current meaning with its family's known meanings, and stamps known_at", async () => {
    const { lift, collect } = await savedFamily();
    await known(lift);
    const { picks } = await nextSession();

    expect(picks.find((pick) => pick.gloss_id === collect)).toMatchObject({ known_meanings: ['להרים'] });
    expect(picks.filter((pick) => pick.known_meanings !== undefined)).toHaveLength(1);
    expect((await readFamilyMembers(t.db, E)).map(({ glossId, state, knownAt }) => ({ glossId, state, knownAt }))).toEqual([
      { glossId: lift, state: 'known', knownAt: NOW },
      { glossId: collect, state: 'current', knownAt: null },
    ]);
  });

  it('writes no new event when nothing changed since the last creation', async () => {
    await savedFamily();
    await nextSession();
    const members = await readFamilyMembers(t.db, E);
    const events = await readFamilyEvents(t.db, E);
    expect(events).toHaveLength(2);

    await nextSession();
    expect(await readFamilyMembers(t.db, E)).toEqual(members);
    expect(await readFamilyEvents(t.db, E)).toEqual(events);
  });

  it('keeps a known meaning known through a lapse (spec D2)', async () => {
    const { lift, collect } = await savedFamily();
    await known(lift);
    await nextSession();
    const events = await readFamilyEvents(t.db, E);

    // A typo: spelling drops to about a day.
    await setMemoryStability(t.db, { enrollmentId: E, glossId: lift, dimension: 'spelling', stability: 1 });
    await nextSession();

    expect((await readFamilyMembers(t.db, E)).map(({ glossId, state, knownAt }) => ({ glossId, state, knownAt }))).toEqual([
      { glossId: lift, state: 'known', knownAt: NOW },
      { glossId: collect, state: 'current', knownAt: null },
    ]);
    expect(await readFamilyEvents(t.db, E)).toEqual(events);
  });
});
