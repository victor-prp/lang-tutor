import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createDb } from '../../../src/db/client';
import { createHealthRepo } from '../../../src/repo/health';
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
    expect(await createHealthRepo(t.db).ping()).toBe(true);
  });

  it('reports false when the connection fails, instead of throwing', async () => {
    // A pool pointed at a port nothing listens on: a real connection failure,
    // with no global state touched and nothing mocked. app.test.ts reaches its
    // own 503 branch with a fake ping instead, which is why it stays fast.
    const dead = createDb('postgres://postgres:postgres@localhost:1/none', {
      onError: () => {},
    });
    try {
      expect(await createHealthRepo(dead.db).ping()).toBe(false);
    } finally {
      await dead.close().catch(() => undefined);
    }
  });
});
