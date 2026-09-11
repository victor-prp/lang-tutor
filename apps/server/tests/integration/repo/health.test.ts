import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createDb } from '../../../src/db/client';
import { createHealthRepo } from '../../../src/repo/health';
import { createFakeLogger } from '../../support/fakes';
import { createTestDb, type TestDb } from '../../support/testDb';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

describe('createHealthRepo', () => {
  it('reports true when the database answers', async () => {
    expect(await createHealthRepo(t.db, createFakeLogger()).ping()).toBe(true);
  });

  it('reports false when the connection fails, instead of throwing, and logs why', async () => {
    // A pool pointed at a port nothing listens on: a real connection failure,
    // with no global state touched and nothing mocked. app.test.ts reaches its
    // own 503 branch with a fake ping instead, which is why it stays fast.
    const dead = createDb('postgres://postgres:postgres@localhost:1/none', {
      onError: () => {},
    });
    const logger = createFakeLogger();
    try {
      expect(await createHealthRepo(dead.db, logger).ping()).toBe(false);
      // A dead database ping used to fail silently — nothing distinguished a
      // real outage from a slow-but-healthy one anywhere in the log.
      expect(logger.errors).toHaveLength(1);
      expect(logger.errors[0].message).toBe('health check failed');
    } finally {
      await dead.close().catch(() => undefined);
    }
  });
});
