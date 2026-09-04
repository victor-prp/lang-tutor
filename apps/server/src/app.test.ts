import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createApp } from './app';
import { createDb } from './db/client';
import { createTestDb, type TestDb } from '../tests/support/testDb';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

describe('GET /health', () => {
  it('returns 200 with ok: true when the database answers', async () => {
    const res = await createApp(t.db).request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('does not create a session as a side effect', async () => {
    const app = createApp(t.db);
    await app.request('/health');
    const res = await app.request('/api/sessions/00000000-0000-0000-0000-000000000000/next-step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'u1', question_id: 'q-window', option_index: 0 }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 503 when the database is unreachable', async () => {
    // A pool pointed at a port nothing listens on: a real connection failure,
    // with no global state touched and nothing mocked.
    const dead = createDb('postgres://postgres:postgres@localhost:1/none');
    try {
      const res = await createApp(dead.db).request('/health');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false });
    } finally {
      await dead.close().catch(() => undefined);
    }
  });
});
