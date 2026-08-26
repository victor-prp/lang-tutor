import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { createApp } from '../../src/app';

let server: ReturnType<typeof serve>;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = serve({ fetch: createApp().fetch, port: 0 }, (info) => {
      baseUrl = `http://localhost:${info.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
});
