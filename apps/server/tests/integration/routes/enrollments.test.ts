import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import { createEnrollmentsRouter } from '../../../src/routes/enrollments';
import { createFakeLogger } from '../../support/fakes';
import { createTestServerDeps } from '../../support/serverDeps';
import { seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1'); // enrolled in English
});
afterEach(async () => {
  await t.close();
});

function buildTestApp() {
  const deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });
  const app = new Hono();
  app.route('/api', createEnrollmentsRouter(deps.enrollments));
  return app;
}

const post = (app: Hono, userId: string, body: unknown) =>
  app.request(`/api/users/${userId}/enrollments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/users/{id}/enrollments', () => {
  it('creates a second enrollment in another target', async () => {
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

  it('answers 404 for a user nobody registered', async () => {
    const res = await post(buildTestApp(), 'u_nobody', { source_language: 'he', target_language: 'ru' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'user not found' });
  });
});

describe('GET /api/users/{id}/enrollments', () => {
  it('lists every enrollment, newest first', async () => {
    const app = buildTestApp();
    await post(app, 'u_1', { source_language: 'he', target_language: 'ru' });
    const res = await app.request('/api/users/u_1/enrollments');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { target_language: string }[];
    expect(body.map((e) => e.target_language)).toEqual(['ru', 'en']);
  });

  it('answers 404 for a user nobody registered', async () => {
    const res = await buildTestApp().request('/api/users/u_nobody/enrollments');
    expect(res.status).toBe(404);
  });
});
