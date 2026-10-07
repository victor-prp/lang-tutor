import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import { createGrantsRouter } from '../../../src/routes/grants';
import { createFakeLogger } from '../../support/fakes';
import { createTestServerDeps } from '../../support/serverDeps';
import { seedEnrollment, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_student');
  await seedUser(t.db, 'u_tutor');
  await seedUser(t.db, 'u_stranger');
  await seedEnrollment(t.db, { id: 'e_student_ru', userId: 'u_student', targetLanguage: 'ru' });
});
afterEach(async () => {
  await t.close();
});

function app() {
  const deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });
  const hono = new Hono();
  hono.route('/api', createGrantsRouter(deps.grants));
  return hono;
}

const headers = (actor?: string): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...(actor ? { 'X-Acting-User-Id': actor } : {}),
});
const invite = (body: unknown, actor?: string) =>
  app().request('/api/grants', { method: 'POST', headers: headers(actor), body: JSON.stringify(body) });
const inviteRussian = (actor = 'u_tutor') => invite({ username: 'u_student', target_language: 'ru' }, actor);
const listGrants = (actor?: string) => app().request('/api/grants', { headers: headers(actor) });
const accept = (id: string, actor?: string) =>
  app().request(`/api/grants/${id}/accept`, { method: 'POST', headers: headers(actor) });
const end = (id: string, actor?: string) =>
  app().request(`/api/grants/${id}`, { method: 'DELETE', headers: headers(actor) });

async function pendingGrant() {
  const res = await inviteRussian();
  return (await res.json()) as { id: string };
}

const INVALID = { error: 'invalid request' };

describe('POST /api/grants', () => {
  it('answers 201 and the pending grant for a valid invite', async () => {
    const res = await inviteRussian();
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      role: 'tutor',
      status: 'pending',
      enrollment: { id: 'e_student_ru', target_language: 'ru' },
      owner: { id: 'u_student' },
      grantee: { id: 'u_tutor' },
    });
  });

  it('answers 400 with no actor header', async () => {
    const res = await invite({ username: 'u_student', target_language: 'ru' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INVALID);
  });

  it('answers 400 for a username with capitals', async () => {
    const res = await invite({ username: 'Victor', target_language: 'ru' }, 'u_tutor');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INVALID);
  });

  it('answers 404 for an unknown username', async () => {
    const res = await invite({ username: 'nobody', target_language: 'ru' }, 'u_tutor');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'user not found' });
  });

  it('answers 409 not_learning for a language the student is not learning', async () => {
    const res = await invite({ username: 'u_student', target_language: 'it' }, 'u_tutor');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_learning' });
  });

  it('answers 409 own_list when inviting yourself', async () => {
    const res = await invite({ username: 'u_student', target_language: 'ru' }, 'u_student');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'own_list' });
  });

  it('answers 409 grant_exists for a second invite', async () => {
    await inviteRussian();
    const res = await inviteRussian();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'grant_exists' });
  });
});

describe('GET /api/grants', () => {
  it('answers each party its side', async () => {
    const grant = await pendingGrant();
    const student = await listGrants('u_student');
    expect(student.status).toBe(200);
    expect(await student.json()).toEqual({ tutors: [expect.objectContaining({ id: grant.id })], students: [] });
    const tutor = await listGrants('u_tutor');
    expect(tutor.status).toBe(200);
    expect(await tutor.json()).toEqual({ tutors: [], students: [expect.objectContaining({ id: grant.id })] });
  });

  it('answers empty lists to a stranger', async () => {
    await pendingGrant();
    const res = await listGrants('u_stranger');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tutors: [], students: [] });
  });

  it('answers 400 with no actor header', async () => {
    const res = await listGrants();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INVALID);
  });
});

describe('POST /api/grants/{id}/accept', () => {
  it('answers 200 and the accepted grant for the owner', async () => {
    const grant = await pendingGrant();
    const res = await accept(grant.id, 'u_student');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: grant.id, status: 'accepted', accepted_at: expect.any(String) });
  });

  it('answers 403 forbidden for the tutor', async () => {
    const grant = await pendingGrant();
    const res = await accept(grant.id, 'u_tutor');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('answers 404 grant not found for no such grant', async () => {
    const res = await accept('g_missing', 'u_student');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'grant not found' });
  });

  it('answers 400 with no actor header', async () => {
    const grant = await pendingGrant();
    const res = await accept(grant.id);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INVALID);
  });
});

describe('DELETE /api/grants/{id}', () => {
  it('answers 204 for the owner', async () => {
    const grant = await pendingGrant();
    const res = await end(grant.id, 'u_student');
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('answers 204 for the grantee', async () => {
    const grant = await pendingGrant();
    const res = await end(grant.id, 'u_tutor');
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('answers 204 for a missing id', async () => {
    const res = await end('g_missing', 'u_student');
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('answers 403 forbidden for a stranger', async () => {
    const grant = await pendingGrant();
    const res = await end(grant.id, 'u_stranger');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('answers 400 with no actor header', async () => {
    const grant = await pendingGrant();
    const res = await end(grant.id);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INVALID);
  });
});
