import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import { createMeRouter } from '../../../src/routes/me';
import { createUsersRouter } from '../../../src/routes/users';
import { ACT_AS, actAs } from '../../support/actAs';
import { createFakeLogger } from '../../support/fakes';
import { seedIdentity } from '../../support/seedUser';
import { createTestServerDeps } from '../../support/serverDeps';
import { testRng } from '../../support/testRng';
import { createTestDb, type TestDb } from '../../support/testDb';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  // Phase 29: a signed-in user has an identity before they have a profile.
  await seedIdentity(t.db, 'u_dana');
  await seedIdentity(t.db, 'u_other');
});

afterEach(async () => {
  await t.close();
});

// Production's assembly with a per-test database, exactly as the sessions route
// test does it. A route test that hand-wired repositories would be testing a
// graph this server never builds. actAs stands in for the session middleware.
function buildTestApp() {
  const app = new Hono();
  const deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });
  app.use('*', actAs());
  app.route('/api', createMeRouter(deps.users));
  app.route('/api', createUsersRouter(deps.users));
  return app;
}

function postJson(app: Hono, path: string, actor: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [ACT_AS]: actor },
    body: JSON.stringify(body),
  });
}

const REQUEST = {
  username: 'dana',
  display_name: 'דנה',
  age: 34,
  native_language: 'he',
};

describe('POST /api/users', () => {
  it("creates the signed-in user's profile under their own id", async () => {
    const res = await postJson(buildTestApp(), '/api/users', 'u_dana', REQUEST);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'u_dana', ...REQUEST });
  });

  it('answers 409 profile exists for a second profile', async () => {
    const app = buildTestApp();
    expect((await postJson(app, '/api/users', 'u_dana', REQUEST)).status).toBe(201);

    const res = await postJson(app, '/api/users', 'u_dana', { ...REQUEST, username: 'dana_two' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'profile exists' });
  });

  it('answers 409 username is already taken when another user holds it', async () => {
    const app = buildTestApp();
    await postJson(app, '/api/users', 'u_dana', REQUEST);

    const res = await postJson(app, '/api/users', 'u_other', { ...REQUEST, display_name: 'אחרת' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'username is already taken' });
  });

  it('returns 400 with the contract error body for a malformed request', async () => {
    const res = await postJson(buildTestApp(), '/api/users', 'u_dana', { ...REQUEST, username: 'Dana' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });

  it('ignores an id in the body: the profile is the actor’s', async () => {
    const res = await postJson(buildTestApp(), '/api/users', 'u_dana', { ...REQUEST, id: 'chosen-by-client' });
    expect(res.status).toBe(201);
    expect((await res.json()).id).toBe('u_dana');
  });
});

describe('GET /api/me', () => {
  it('answers the signed-in address with no profile before onboarding', async () => {
    const res = await buildTestApp().request('/api/me', { headers: { [ACT_AS]: 'u_dana' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'u_dana@test.invalid', user: null });
  });

  it('answers the profile after it', async () => {
    const app = buildTestApp();
    const created = await (await postJson(app, '/api/users', 'u_dana', REQUEST)).json();
    const res = await app.request('/api/me', { headers: { [ACT_AS]: 'u_dana' } });
    expect(await res.json()).toEqual({ email: 'u_dana@test.invalid', user: created });
  });
});
