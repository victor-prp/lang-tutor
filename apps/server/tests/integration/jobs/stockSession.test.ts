import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import { JOB_SCHEMA } from '../../../src/db/jobs';
import { PREPARE_SESSION, STOCK_SESSION, type PrepareSessionPayload, type StockSessionPayload } from '../../../src/domain/jobs';
import type { SessionService } from '../../../src/services/sessions';
import type { VocabularyService } from '../../../src/services/vocabulary';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger } from '../../support/fakes';
import { jobPayloads, startTestBoss, stopTestBoss } from '../../support/jobs';
import { insertListSession } from '../../support/questions';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { seedTarget } from '../../support/targetRows';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

// Phase 43 (spec D2–D4). The stock job through a real pg-boss: the triggers send
// real jobs, with the queue's policy, and the handler builds from the database.
// No worker runs: the handler is called with each job's payload, so nothing here
// races a poll, and no model is called (the stock's own preparation is
// prepareSession's, tested on its own).

let t: TestDb;
let boss: PgBoss;
let sessions: SessionService;
let vocabulary: VocabularyService;
const E = enrollmentOf('u_1');

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  boss = await startTestBoss(t.db);
  const deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7), boss });
  sessions = deps.sessions;
  vocabulary = deps.vocabulary;
});

afterEach(async () => {
  await stopTestBoss(boss);
  await t.close();
});

type QueuedJob = { singleton_key: string | null; held: boolean };
async function stockJobs(): Promise<QueuedJob[]> {
  const rows = await t.db.execute<QueuedJob>(
    sql`select singleton_key, start_after > now() as held from ${sql.raw(JOB_SCHEMA)}.job where name = ${STOCK_SESSION} order by created_on`,
  );
  return rows.rows;
}

/** When the one held stock job may start, in epoch microseconds. */
async function heldUntil(): Promise<number> {
  const rows = await t.db.execute<{ at: string }>(
    sql`select (extract(epoch from start_after) * 1000000)::bigint::text as at from ${sql.raw(JOB_SCHEMA)}.job where name = ${STOCK_SESSION}`,
  );
  expect(rows.rows).toHaveLength(1);
  return Number(rows.rows[0].at);
}

async function savedWord(lemma: string, translation: string) {
  const saved = await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [translation] });
  return { glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation };
}

describe('the stock job', () => {
  it('builds the next session while one is started, asking its words last', async () => {
    const dog = await savedWord('dog', 'כלב');
    const cat = await savedWord('cat', 'חתול');
    const owl = await savedWord('owl', 'ינשוף');
    const { sessionId: started } = await insertListSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      asked: [dog],
      types: ['multiple_choice'],
    });

    await sessions.startSession('u_1', started, { listening: true, speaking: false });
    const [stock] = (await jobPayloads(t.db, STOCK_SESSION)) as StockSessionPayload[];
    expect(stock).toEqual({ enrollment_id: E, reason: 'start', listening: true, speaking: false });
    expect(await stockJobs()).toEqual([{ singleton_key: E, held: false }]);

    await sessions.stockSession(stock);

    const [prepare] = (await jobPayloads(t.db, PREPARE_SESSION)) as PrepareSessionPayload[];
    const asked = prepare.picks.map((pick) => pick.gloss_id);
    expect(asked.slice(0, 2).sort()).toEqual([cat.glossId, owl.glossId].sort());
    expect(asked[asked.length - 1]).toBe(dog.glossId);
    expect(prepare).toMatchObject({ listening: true, speaking: false });
    const home = await sessions.currentSession('u_1', E);
    expect(home.current?.id).toBe(started);
  });

  it('is one job for a burst of triggers, and the stock it builds is offered once the started session ends', async () => {
    const dog = await savedWord('dog', 'כלב');
    await savedWord('cat', 'חתול');
    const { sessionId: started } = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked: [dog], types: ['multiple_choice'] });
    await sessions.startSession('u_1', started, { listening: false, speaking: false });
    await sessions.skipSession('u_1', started);
    expect(await stockJobs()).toEqual([{ singleton_key: E, held: false }]);

    const [stock] = (await jobPayloads(t.db, STOCK_SESSION)) as StockSessionPayload[];
    await sessions.stockSession(stock);
    const home = await sessions.currentSession('u_1', E);
    expect(home.current).toMatchObject({ status: 'preparing', source: 'list' });
    // A second run finds the stock there and builds nothing.
    await sessions.stockSession({ enrollment_id: E, reason: 'complete' });
    expect(await jobPayloads(t.db, PREPARE_SESSION)).toHaveLength(1);
  });

  // Phase 57 (spec D2, ADR 0014). One key per path: a start on each path is a job of its own,
  // and each builds its own path's stock.
  it("keys a stock per path, and builds each path's stock beside its started session", async () => {
    const dog = await savedWord('dog', 'כלב');
    const cat = await savedWord('cat', 'חתול');
    const owl = await savedWord('owl', 'ינשוף');
    const exam = await seedTarget(t.db, { enrollmentId: E, kind: 'exam', dueOn: '2099-01-01', glossIds: [dog.glossId, cat.glossId] });
    const main = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked: [owl], types: ['multiple_choice'] });
    const own = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked: [dog], types: ['multiple_choice'], targetId: exam });

    await sessions.startSession('u_1', main.sessionId, { listening: false, speaking: false });
    await sessions.startSession('u_1', own.sessionId, { listening: false, speaking: false });

    expect(await stockJobs()).toEqual([
      { singleton_key: E, held: false },
      { singleton_key: `${E}:${exam}`, held: false },
    ]);
    const [forMain, forExam] = (await jobPayloads(t.db, STOCK_SESSION)) as StockSessionPayload[];
    expect(forExam).toEqual({ enrollment_id: E, reason: 'start', listening: false, speaking: false, target_id: exam });
    await sessions.stockSession(forMain);
    await sessions.stockSession(forExam);

    const prepared = (await jobPayloads(t.db, PREPARE_SESSION)) as PrepareSessionPayload[];
    expect(prepared).toHaveLength(2);
    const [mainStock, examStock] = prepared;
    // The main path asks only the word no target holds; the exam's, only its own.
    expect(mainStock.picks.map((pick) => pick.gloss_id)).toEqual([owl.glossId]);
    expect(examStock).toMatchObject({ target: true });
    expect([dog.glossId, cat.glossId]).toEqual(expect.arrayContaining(examStock.picks.map((pick) => pick.gloss_id)));
    expect((await sessions.currentSession('u_1', E)).current?.id).toBe(main.sessionId);
    expect((await sessions.currentSession('u_1', E, exam)).current?.id).toBe(own.sessionId);
  });

  it('holds a save back half a minute under a key of its own, and a burst of saves is one job, held past the last', async () => {
    const word = await insertLexeme(t.db, {
      lemma: 'kite',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'toy' }, { senseCode: 'bird' }],
      variants: [
        {
          form: 'kite',
          kind: 'word',
          entryRank: 0,
          translations: [
            { senseCode: 'toy', rank: 0, translation: 'עפיפון', exampleSource: null, exampleTarget: null },
            { senseCode: 'bird', rank: 1, translation: 'דיה', exampleSource: null, exampleTarget: null },
          ],
        },
      ],
    });
    await vocabulary.save('u_1', E, [{ gloss_id: word.glossIds[0], variant_id: word.variantIds[0] }]);
    const first = await heldUntil();
    await vocabulary.save('u_1', E, [{ gloss_id: word.glossIds[1], variant_id: word.variantIds[0] }]);
    expect(await stockJobs()).toEqual([{ singleton_key: `${E}:save`, held: true }]);
    expect(await jobPayloads(t.db, STOCK_SESSION)).toEqual([{ enrollment_id: E, reason: 'save' }]);
    // Review I1. Each save moves the stock half a minute past itself, so the
    // stock holds every word of a burst however long the burst lasts.
    expect(await heldUntil()).toBeGreaterThan(first);
  });
});
