import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';

import { createServerDeps } from '../../src/composition';
import { createFakeLogger } from '../support/fakes';
import { seedUser } from '../support/seedUser';
import { createTestDb, type TestDb } from '../support/testDb';
import { testRng } from '../support/testRng';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
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
    const { record } = await deps.sessions.startSession('u_1');
    expect(record.questions).toHaveLength(SESSION_LENGTH);
  });
});
