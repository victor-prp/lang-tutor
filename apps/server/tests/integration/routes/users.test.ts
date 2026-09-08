import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import { createTestServerDeps } from '../../support/serverDeps';
import { createUsersRouter } from '../../../src/routes/users';
import { createFakeLogger } from '../../support/fakes';
import { testRng } from '../../support/testRng';
import { createTestDb, type TestDb } from '../../support/testDb';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

// Production's assembly with a per-test database, exactly as the sessions route
// test does it. A route test that hand-wired repositories would be testing a
// graph this server never builds.
function buildTestApp() {
  const app = new Hono();
  const deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });
  app.route('/api', createUsersRouter(deps.users));
  return app;
}

function postJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const REQUEST = {
  username: 'dana',
  display_name: 'דנה',
  age: 34,
  native_language: 'he',
  target_language: 'en',
};

describe('POST /api/users', () => {
  it('creates a user and returns it with a server-issued id', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/users', REQUEST);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ id: expect.any(String), ...REQUEST });
  });

  it('returns 409 when the username is taken', async () => {
    const app = buildTestApp();
    await postJson(app, '/api/users', REQUEST);

    const res = await postJson(app, '/api/users', { ...REQUEST, display_name: 'אחרת' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'username is already taken' });
  });

  it('returns 400 for a matching language pair', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/users', { ...REQUEST, target_language: 'he' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'native and target language must differ' });
  });

  it('returns 400 with the contract error body for a malformed request', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/users', { ...REQUEST, username: 'Dana' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });

  it('ignores an id supplied by the caller', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/users', { ...REQUEST, id: 'chosen-by-client' });
    expect(res.status).toBe(201);
    expect((await res.json()).id).not.toBe('chosen-by-client');
  });
});

describe('POST /api/login', () => {
  it('returns the user for a known username', async () => {
    const app = buildTestApp();
    const created = await (await postJson(app, '/api/users', REQUEST)).json();

    const res = await postJson(app, '/api/login', { username: 'dana' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(created);
  });

  it('returns 404 for a username nobody registered', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/login', { username: 'nobody' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no such user' });
  });

  it('returns 400 with the contract error body for a malformed username', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/login', { username: 'D' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });
});
