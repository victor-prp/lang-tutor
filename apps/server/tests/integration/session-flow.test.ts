import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { createApp } from '../../src/app';
import { createTestDb, type TestDb } from '../support/testDb';

let server: ReturnType<typeof serve>;
let baseUrl: string;
let t: TestDb;

beforeAll(async () => {
  // beforeAll, not beforeEach: this file starts a real server, and the one test
  // in it needs the database to outlive the request/response cycle.
  t = await createTestDb();
  await new Promise<void>((resolve) => {
    server = serve({ fetch: createApp(t.db).fetch, port: 0 }, (info) => {
      baseUrl = `http://localhost:${info.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await t.close();
});

async function postJson(path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('integration: a full session over real HTTP', () => {
  it('creates a session, answers all 10 questions correctly, and completes with a perfect score', async () => {
    const created = await postJson('/api/sessions', { user_id: 'integration-user' });
    expect(created.status).toBe(200);
    expect(created.body.position).toEqual({ position: 1, total: 10 });

    let current = created.body;
    let last;
    for (let i = 0; i < 10; i++) {
      const res = await postJson(`/api/sessions/${current.session_id}/next-step`, {
        user_id: 'integration-user',
        question_id: current.question.id,
        option_index: current.question.correct_option,
      });
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
    const created = await postJson('/api/sessions', { user_id: 'restart-user' });
    const sessionId = created.body.session_id;

    let current = created.body;
    let lastQuestionId = current.question.id;
    let lastOptionIndex = current.question.correct_option;
    let last;

    for (let i = 0; i < 10; i++) {
      lastQuestionId = current.question.id;
      lastOptionIndex = current.question.correct_option;
      const res = await postJson(`/api/sessions/${sessionId}/next-step`, {
        user_id: 'restart-user',
        question_id: lastQuestionId,
        option_index: lastOptionIndex,
      });
      last = res.body;
      current = last;
    }
    expect(last.complete).toBe(true);

    // The in-memory store swept completed sessions five minutes after they
    // finished, so this would have 404ed. A table has no such sweep, so
    // retrying the tenth answer replays the completed response indefinitely.
    const replay = await postJson(`/api/sessions/${sessionId}/next-step`, {
      user_id: 'restart-user',
      question_id: lastQuestionId,
      option_index: lastOptionIndex,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(last);
  });
});
