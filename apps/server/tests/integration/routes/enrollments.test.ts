import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import { createEnrollmentsRouter } from '../../../src/routes/enrollments';
import { ACT_AS, actAs } from '../../support/actAs';
import { createFakeLogger } from '../../support/fakes';
import { createTestServerDeps } from '../../support/serverDeps';
import { seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1'); // enrolled in English
  await seedUser(t.db, 'u_2'); // ditto, and nobody's business of u_1's
});
afterEach(async () => {
  await t.close();
});

function buildTestApp() {
  const deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });
  const app = new Hono();
  app.use('*', actAs());
  app.route('/api', createEnrollmentsRouter(deps.enrollments));
  return app;
}

const post = (app: Hono, actor: string, body: unknown) =>
  app.request('/api/enrollments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [ACT_AS]: actor },
    body: JSON.stringify(body),
  });

const list = (app: Hono, actor: string) => app.request('/api/enrollments', { headers: { [ACT_AS]: actor } });

describe('POST /api/enrollments', () => {
  it('creates a second enrollment in another target, for the signed-in learner', async () => {
    const res = await post(buildTestApp(), 'u_1', { source_language: 'he', target_language: 'ru' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      user_id: 'u_1',
      source_language: 'he',
      target_language: 'ru',
    });
  });

  it('answers 409 for a target the learner already holds — what a double tap sends', async () => {
    const app = buildTestApp();
    expect((await post(app, 'u_1', { source_language: 'he', target_language: 'ru' })).status).toBe(201);
    const again = await post(app, 'u_1', { source_language: 'he', target_language: 'ru' });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'already enrolled' });
  });

  it('enrolls in Italian beside English, and only once', async () => {
    const app = buildTestApp();
    const res = await post(app, 'u_1', { source_language: 'he', target_language: 'it' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ source_language: 'he', target_language: 'it' });
    expect((await post(app, 'u_1', { source_language: 'he', target_language: 'it' })).status).toBe(409);
  });

  it('answers 400 with the standard body for an English source', async () => {
    const res = await post(buildTestApp(), 'u_1', { source_language: 'en', target_language: 'ru' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });

  it('answers 400 with the standard body for the same language twice', async () => {
    const res = await post(buildTestApp(), 'u_1', { source_language: 'he', target_language: 'he' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });
});

describe('GET /api/enrollments', () => {
  it("lists the signed-in learner's enrollments, newest first", async () => {
    const app = buildTestApp();
    await post(app, 'u_1', { source_language: 'he', target_language: 'ru' });
    const res = await list(app, 'u_1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { target_language: string }[];
    expect(body.map((e) => e.target_language)).toEqual(['ru', 'en']);
  });

  // Phase 29 (spec D12): no id in the path, so no way to name someone else.
  it("never shows another learner's", async () => {
    const app = buildTestApp();
    await post(app, 'u_1', { source_language: 'he', target_language: 'ru' });
    const body = (await (await list(app, 'u_2')).json()) as { user_id: string; target_language: string }[];
    expect(body.map((e) => [e.user_id, e.target_language])).toEqual([['u_2', 'en']]);
  });
});
