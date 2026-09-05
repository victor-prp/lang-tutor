import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createDb } from '../db/client';
import { createHealthRepo } from './health';
import { createTestDb, type TestDb } from '../../tests/support/testDb';

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
    // with no global state touched and nothing mocked. This case moves here from
    // app.test.ts, which after Task 4 reaches its 503 branch with a fake.
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
