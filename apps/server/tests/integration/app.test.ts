import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createApp } from '../../src/app';
import { createServerDeps } from '../../src/composition';
import { createFakeLogger } from '../support/fakes';
import { createTestDb, type TestDb } from '../support/testDb';
import { testRng } from '../support/testRng';

// The other half of this file's tests is src/app.test.ts, which covers /health
// against a fake ping and needs no database. This half keeps a real one on
// purpose: it asserts something about the app production actually assembles, so
// faking the service would assert nothing.
describe('the app as production assembles it', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });

  afterEach(async () => {
    await t.close();
  });

  it('does not create a session as a side effect of a health check', async () => {
    const app = createApp(
      createServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) }),
    );
    await app.request('/health');
    const res = await app.request('/api/sessions/00000000-0000-0000-0000-000000000000/next-step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'u1', question_id: 'q-window', option_index: 0 }),
    });
    expect(res.status).toBe(404);
  });
});
