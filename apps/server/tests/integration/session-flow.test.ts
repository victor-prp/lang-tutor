import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { createApp } from '../../src/app';
import { signUpWithProfile } from '../support/auth';
import { createTestServerDeps } from '../support/serverDeps';
import { createFakeLogger } from '../support/fakes';
import { expectEmails, mailBaseUrlFor, mockNamespace } from '../support/mockServer';
import { createTestDb, type TestDb } from '../support/testDb';
import { testRng } from '../support/testRng';

let server: ReturnType<typeof serve>;
let baseUrl: string;
let t: TestDb;
let app: ReturnType<typeof createApp>;
let ns: string;

beforeAll(async () => {
  // beforeAll, not beforeEach: this file starts a real server, and the one test
  // in it needs the database to outlive the request/response cycle.
  t = await createTestDb();
  ns = mockNamespace('session-flow');
  await expectEmails(ns);
  app = createApp(
    createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7), mailBaseUrl: mailBaseUrlFor(ns) }),
  );
  await new Promise<void>((resolve) => {
    server = serve(
      {
        fetch: app.fetch,
        port: 0,
      },
      (info) => {
        baseUrl = `http://localhost:${info.port}`;
        resolve();
      },
    );
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await t.close();
});

// Phase 29. A learner as the app makes one: signed in by code, onboarded, and
// enrolled in English over the wire; every later request carries the cookie.
async function learner(username: string): Promise<{ cookie: string; enrollmentId: string }> {
  const { cookie } = await signUpWithProfile(app, ns, { email: `${username}@example.com`, username });
  const enrolled = await postJson('/api/enrollments', { source_language: 'he', target_language: 'en' }, cookie);
  expect(enrolled.status).toBe(201);
  return { cookie, enrollmentId: enrolled.body.id };
}

async function postJson(path: string, body: unknown, cookie: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function getJson(path: string, cookie: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
  return { status: res.status, body: await res.json() };
}

describe('integration: a full session over real HTTP', () => {
  it('creates a session, answers all 10 questions correctly, and completes with a perfect score', async () => {
    const { cookie, enrollmentId } = await learner('integration_user');
    const created = await postJson('/api/sessions', { enrollment_id: enrollmentId }, cookie);
    expect(created.status).toBe(201);
    const view = await getJson(`/api/sessions/${created.body.session_id}`, cookie);
    expect(view.body.position).toEqual({ position: 1, total: 10 });

    let current = view.body;
    let last;
    for (let i = 0; i < 10; i++) {
      const res = await postJson(
        `/api/sessions/${current.session_id}/next-step`,
        { question_id: current.question.id, option_index: current.question.correct_option },
        cookie,
      );
      expect(res.status).toBe(200);
      last = res.body;
      current = last;
    }

    expect(last.complete).toBe(true);
    expect(last.question).toBeNull();
    expect(last.score).toEqual({ correct: 10, total: 10 });
    expect(last.missed_questions).toEqual([]);
  });

  it('keeps a completed session readable, so a retry replays instead of 404ing', async () => {
    const { cookie, enrollmentId } = await learner('restart_user');
    const created = await postJson('/api/sessions', { enrollment_id: enrollmentId }, cookie);
    const sessionId = created.body.session_id;

    const view = await getJson(`/api/sessions/${sessionId}`, cookie);
    let current = view.body;
    let lastQuestionId = current.question.id;
    let lastOptionIndex = current.question.correct_option;
    let last;

    for (let i = 0; i < 10; i++) {
      lastQuestionId = current.question.id;
      lastOptionIndex = current.question.correct_option;
      const res = await postJson(
        `/api/sessions/${sessionId}/next-step`,
        { question_id: lastQuestionId, option_index: lastOptionIndex },
        cookie,
      );
      last = res.body;
      current = last;
    }
    expect(last.complete).toBe(true);

    // The in-memory store swept completed sessions five minutes after they
    // finished, so this would have 404ed. A table has no such sweep, so
    // retrying the tenth answer replays the completed response indefinitely.
    const replay = await postJson(
      `/api/sessions/${sessionId}/next-step`,
      { question_id: lastQuestionId, option_index: lastOptionIndex },
      cookie,
    );
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(last);
  });
});
