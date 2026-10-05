import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { DIMENSIONS } from '@lang-tutor/core/domain';
import { sql } from 'drizzle-orm';

import { createProgressRepo } from '../../../src/repo/progress';
import { insertLexeme } from '../../support/dictRows';
import {
  insertAnsweredSession,
  insertProgressRows,
  readProgress,
  readSnapshot,
} from '../../support/progressRows';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

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
});
afterEach(async () => {
  await t.close();
});

const repo = <T>(fn: (r: ReturnType<typeof createProgressRepo>) => Promise<T>) =>
  withTx(t.db, (tx) => fn(createProgressRepo(tx)));

/** Saves `senseIndexes` of kite at `at`, with their five rows. */
async function saveAt(at: string, senseIndexes: number[]) {
  for (const i of senseIndexes) {
    await t.db.execute(sql`
      insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, variant_id, created_at)
      values (${E}, ${kite.senseIds[i]}, ${kite.lexemeId}, ${kite.variantIds[0]}, ${at}::timestamptz)`);
  }
  await insertProgressRows(t.db, E, senseIndexes.map((i) => kite.senseIds[i]));
}

const asked = (i: number, translation: string) => ({
  senseId: kite.senseIds[i],
  variantId: kite.variantIds[0],
  translation,
});

describe('findSessionEvidence', () => {
  it("reads each answer in order, right or wrong, with the session's enrollment", async () => {
    const sessionId = await insertAnsweredSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      status: 'completed',
      asked: [asked(0, 'עפיפון'), asked(1, 'דיה')],
      answers: [
        { position: 0, correct: true, at: '2026-10-05 10:00:00+00' },
        { position: 1, correct: false, at: '2026-10-05 10:01:00+00' },
      ],
    });
    expect(await repo((r) => r.findSessionEvidence(sessionId))).toEqual({
      enrollmentId: E,
      day: '2026-10-05',
      lastAnsweredAt: expect.any(String),
      answers: [
        { senseId: kite.senseIds[0], type: 'multiple_choice', correct: true },
        { senseId: kite.senseIds[1], type: 'multiple_choice', correct: false },
      ],
    });
  });

  // Review Focus 1: a session across UTC midnight counts for its last answer's day.
  it('dates a session by the UTC day of its last answer', async () => {
    const sessionId = await insertAnsweredSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      status: 'skipped',
      asked: [asked(0, 'עפיפון'), asked(1, 'דיה')],
      answers: [
        { position: 0, correct: true, at: '2026-10-05 23:59:00+00' },
        { position: 1, correct: true, at: '2026-10-05 21:01:00-03' },
      ],
    });
    expect((await repo((r) => r.findSessionEvidence(sessionId)))?.day).toBe('2026-10-06');
  });

  it('answers undefined for a session with no answers', async () => {
    const sessionId = await insertAnsweredSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      status: 'skipped',
      asked: [asked(0, 'עפיפון')],
      answers: [],
    });
    expect(await repo((r) => r.findSessionEvidence(sessionId))).toBeUndefined();
  });
});

describe('findRows and updateRows', () => {
  it('finds the five rows of each saved sense, and none for an unsaved one', async () => {
    await saveAt('2026-10-01 00:00:00+00', [0]);
    const rows = await repo((r) =>
      r.findRows({ enrollmentId: E, senseIds: [kite.senseIds[0], kite.senseIds[1]], savedBy: null }),
    );
    expect(rows.map((row) => row.dimension).sort()).toEqual([...DIMENSIONS].sort());
    expect(rows.every((row) => row.senseId === kite.senseIds[0] && row.level === 1)).toBe(true);
    expect(rows.every((row) => row.lastStepOn === null && row.lastWrongOn === null)).toBe(true);
  });

  it('leaves out a sense saved after `savedBy`', async () => {
    await saveAt('2026-10-05 12:00:00+00', [0]);
    const find = (savedBy: string) =>
      repo((r) => r.findRows({ enrollmentId: E, senseIds: [kite.senseIds[0]], savedBy }));
    expect(await find('2026-10-05 11:59:59+00')).toEqual([]);
    expect(await find('2026-10-05 12:00:00+00')).toHaveLength(5);
  });

  it('answers nothing for no senses, without a query', async () => {
    expect(await repo((r) => r.findRows({ enrollmentId: E, senseIds: [], savedBy: null }))).toEqual([]);
  });

  it('writes the named rows and no others', async () => {
    await saveAt('2026-10-01 00:00:00+00', [0, 1]);
    await repo((r) =>
      r.updateRows({
        enrollmentId: E,
        rows: [
          { senseId: kite.senseIds[0], dimension: 'written_receptive', level: 3, lastStepOn: '2026-10-06', lastWrongOn: '2026-10-04' },
        ],
      }),
    );
    const stored = await readProgress(t.db, E);
    expect(stored.find((row) => row.senseId === kite.senseIds[0] && row.dimension === 'written_receptive')).toEqual({
      senseId: kite.senseIds[0],
      dimension: 'written_receptive',
      level: 3,
      lastStepOn: '2026-10-06',
      lastWrongOn: '2026-10-04',
    });
    expect(stored.filter((row) => row.level !== 1)).toHaveLength(1);
  });
});

describe('insertSnapshot and findSnapshot', () => {
  it('reads each row back with the form and the right answer of the first question that asked it', async () => {
    await saveAt('2026-10-01 00:00:00+00', [0]);
    const sessionId = await insertAnsweredSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      status: 'completed',
      asked: [asked(1, 'דיה'), asked(0, 'עפיפון'), asked(0, 'עפיפון')],
      answers: [],
    });
    await repo((r) =>
      r.insertSnapshot({
        sessionId,
        rows: [{ senseId: kite.senseIds[0], dimension: 'written_receptive', levelBefore: 1, levelAfter: 2 }],
      }),
    );
    expect(await repo((r) => r.findSnapshot(sessionId))).toEqual([
      {
        senseId: kite.senseIds[0],
        dimension: 'written_receptive',
        levelBefore: 1,
        levelAfter: 2,
        form: 'kite',
        translation: 'עפיפון',
        position: 1,
      },
    ]);
  });
});

describe("the recompute's reads", () => {
  it('resets every row and every snapshot', async () => {
    await saveAt('2026-10-01 00:00:00+00', [0]);
    const sessionId = await insertAnsweredSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      status: 'completed',
      asked: [asked(0, 'עפיפון')],
      answers: [{ position: 0, correct: true, at: '2026-10-02 10:00:00+00' }],
    });
    await repo((r) =>
      r.insertSnapshot({
        sessionId,
        rows: [{ senseId: kite.senseIds[0], dimension: 'written_receptive', levelBefore: 1, levelAfter: 2 }],
      }),
    );
    await t.db.execute(sql`update sense_progress set level = 4, last_step_on = '2026-10-02'`);
    expect(await readSnapshot(t.db, sessionId)).toHaveLength(1);

    await repo((r) => r.resetAll());

    expect((await readProgress(t.db, E)).every((row) => row.level === 1 && row.lastStepOn === null)).toBe(true);
    expect(await readSnapshot(t.db, sessionId)).toEqual([]);
  });

  it('lists ended sessions with answers in the order of their last answer', async () => {
    const later = await insertAnsweredSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      status: 'completed',
      asked: [asked(0, 'עפיפון')],
      answers: [{ position: 0, correct: true, at: '2026-10-06 10:00:00+00' }],
    });
    const earlier = await insertAnsweredSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      status: 'skipped',
      asked: [asked(0, 'עפיפון')],
      answers: [{ position: 0, correct: true, at: '2026-10-05 10:00:00+00' }],
    });
    await insertAnsweredSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      status: 'skipped',
      asked: [asked(0, 'עפיפון')],
      answers: [],
    });
    await insertAnsweredSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      status: 'ready',
      asked: [asked(0, 'עפיפון')],
      answers: [{ position: 0, correct: true, at: '2026-10-07 10:00:00+00' }],
    });
    expect(await repo((r) => r.listEndedSessions())).toEqual([earlier, later]);
  });
});
