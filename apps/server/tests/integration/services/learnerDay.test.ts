import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PgBoss } from 'pg-boss';

import { eq, sql } from 'drizzle-orm';

import { users } from '../../../src/db/schema';
import type { SessionRecord } from '../../../src/domain/session';
import type { SessionService } from '../../../src/services/sessions';
import { createFakeLogger } from '../../support/fakes';
import { startTestBoss, stopTestBoss } from '../../support/jobs';
import { readProgress, saveSessionGlosses, sessionDay, setLastStep } from '../../support/progressRows';
import { asChoice } from '../../support/questions';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

// Phase 35 (spec D10, D11). The day a session counts for comes from
// learnerDay: the UTC date of the clock for a learner, the profile's bot_day
// for a bot.

const E = enrollmentOf('u_1');

let t: TestDb;
let boss: PgBoss;
let clock: number;
let service: SessionService;

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  boss = await startTestBoss(t.db);
  clock = Date.parse('2026-03-04T23:59:00Z');
  service = createTestServerDeps({
    db: t.db,
    logger: createFakeLogger(),
    rng: testRng(7),
    boss,
    now: () => clock,
  }).sessions;
});

afterEach(async () => {
  await stopTestBoss(boss);
  await t.close();
});

async function makeBot(botDay: string) {
  await t.db.update(users).set({ kind: 'bot', botDay }).where(eq(users.id, 'u_1'));
}

async function start() {
  const { sessionId } = await service.createNextSession('u_1', E, { listening: false, speaking: false });
  const record = await service.getSession('u_1', sessionId);
  return { sessionId, record };
}

async function answerAll(sessionId: string, record: SessionRecord) {
  for (const question of record.questions) {
    const q = asChoice(question);
    await service.submitAnswer('u_1', sessionId, q.id, { option_index: q.correct_option });
  }
}

describe('the day a session counts for', () => {
  it("is a learner's UTC date when the session completes", async () => {
    const { sessionId, record } = await start();
    await answerAll(sessionId, record);
    expect(await sessionDay(t.db, sessionId)).toBe('2026-03-04');
  });

  it("is a learner's UTC date when the session is skipped", async () => {
    const { sessionId } = await start();
    clock = Date.parse('2026-03-05T00:00:01Z');
    await service.skipSession('u_1', sessionId);
    expect(await sessionDay(t.db, sessionId)).toBe('2026-03-05');
  });

  it("is a bot's bot_day, whatever the clock says", async () => {
    await makeBot('2030-01-09');
    const { sessionId, record } = await start();
    await answerAll(sessionId, record);
    expect(await sessionDay(t.db, sessionId)).toBe('2030-01-09');
  });

  it('is unset while the session is open', async () => {
    const { sessionId } = await start();
    const rows = await t.db.execute<{ day: string | null }>(
      sql`select practice_day::text as day from sessions where id = ${sessionId}`,
    );
    expect(rows.rows[0].day).toBeNull();
  });
});

describe("the level rule's gap counts the bot's day", () => {
  async function stepOnBotDay(botDay: string) {
    await makeBot(botDay);
    const { sessionId, record } = await start();
    const [gloss] = await saveSessionGlosses(t.db, { sessionId, enrollmentId: E, positions: [0] });
    await setLastStep(t.db, {
      enrollmentId: E,
      glossId: gloss,
      dimension: 'written_receptive',
      level: 2,
      lastStepOn: '2030-01-08',
    });
    await answerAll(sessionId, record);
    const row = (await readProgress(t.db, E)).find(
      (r) => r.glossId === gloss && r.dimension === 'written_receptive',
    )!;
    return row.level;
  }

  it('steps on the day after the last step', async () => {
    expect(await stepOnBotDay('2030-01-09')).toBe(3);
  });

  it('does not step on the same day', async () => {
    expect(await stepOnBotDay('2030-01-08')).toBe(2);
  });
});
