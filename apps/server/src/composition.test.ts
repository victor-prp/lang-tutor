import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';

import { createServerDeps } from './composition';
import { createFakeLogger } from '../tests/support/fakes';
import { createTestDb, type TestDb } from '../tests/support/testDb';
import { testRng } from '../tests/support/testRng';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

// The seam proof for the wiring layer itself: production's assembly, called with
// a per-test database and a fake logger — no socket, no environment.
describe('createServerDeps', () => {
  it('passes the logger it is given straight through', () => {
    const logger = createFakeLogger();
    expect(createServerDeps({ db: t.db, logger, rng: testRng(7) }).logger).toBe(logger);
  });

  it('assembles a health repo bound to the database it is given', async () => {
    const deps = createServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });
    expect(await deps.health.ping()).toBe(true);
  });

  it('assembles a session service that works against that database', async () => {
    const deps = createServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });
    const { record } = await deps.sessions.startSession('u1');
    expect(record.questions).toHaveLength(SESSION_LENGTH);
  });
});
