import { describe, expect, it } from '@jest/globals';
import type { Question } from '@lang-tutor/core/api';
import { Hono } from 'hono';

import { createSessionStore } from '../store/sessionStore';
import { createSessionsRouter } from './sessions';

function makeQuestion(n: number): Question {
  return {
    id: `q${n}`,
    type: 'multiple_choice',
    vocab_entry_id: `v${n}`,
    question: `word ${n}`,
    options: [`a${n}`, `b${n}`, `c${n}`, `d${n}`],
    correct_option: 0,
  };
}

const POOL: Question[] = Array.from({ length: 16 }, (_, i) => makeQuestion(i));

function buildTestApp() {
  const app = new Hono();
  app.route('/api/sessions', createSessionsRouter(createSessionStore(), POOL));
  return app;
}

function postJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/sessions', () => {
  it('creates a session and returns the first question', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/sessions', { user_id: 'u1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.session_id).toBe('string');
    expect(body.position).toEqual({ position: 1, total: 10 });
    expect(body.question.id).toBeDefined();
  });

  it('rejects a missing user_id', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/sessions', {});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/sessions/:id/next-step', () => {
  it('404s for an unknown session id', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/sessions/does-not-exist/next-step', {
      user_id: 'u1',
      question_id: 'q0',
      option_index: 0,
    });
    expect(res.status).toBe(404);
  });

  it('advances to the next question on a fresh answer', async () => {
    const app = buildTestApp();
    const created = await (await postJson(app, '/api/sessions', { user_id: 'u1' })).json();

    const res = await postJson(app, `/api/sessions/${created.session_id}/next-step`, {
      user_id: 'u1',
      question_id: created.question.id,
      option_index: created.question.correct_option,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.complete).toBe(false);
    expect(body.position).toEqual({ position: 2, total: 10 });
    expect(body.question.id).not.toBe(created.question.id);
  });

  it('replays the same response when the same step is retried', async () => {
    const app = buildTestApp();
    const created = await (await postJson(app, '/api/sessions', { user_id: 'u1' })).json();
    const stepBody = {
      user_id: 'u1',
      question_id: created.question.id,
      option_index: created.question.correct_option,
    };

    const first = await (
      await postJson(app, `/api/sessions/${created.session_id}/next-step`, stepBody)
    ).json();
    const retry = await (
      await postJson(app, `/api/sessions/${created.session_id}/next-step`, stepBody)
    ).json();
    expect(retry).toEqual(first);
  });

  it("409s when question_id does not match the session's current question", async () => {
    const app = buildTestApp();
    const created = await (await postJson(app, '/api/sessions', { user_id: 'u1' })).json();

    const res = await postJson(app, `/api/sessions/${created.session_id}/next-step`, {
      user_id: 'u1',
      question_id: 'not-the-current-question',
      option_index: 0,
    });
    expect(res.status).toBe(409);
  });

  it('completes the session on the 10th answer, returning score and missed_questions', async () => {
    const app = buildTestApp();
    let current = await (await postJson(app, '/api/sessions', { user_id: 'u1' })).json();

    let last;
    for (let i = 0; i < 10; i++) {
      last = await (
        await postJson(app, `/api/sessions/${current.session_id}/next-step`, {
          user_id: 'u1',
          question_id: current.question.id,
          option_index: current.question.correct_option,
        })
      ).json();
      current = last;
    }

    expect(last.complete).toBe(true);
    expect(last.question).toBeNull();
    expect(last.score).toEqual({ correct: 10, total: 10 });
    expect(last.missed_questions).toEqual([]);
  });

  it('tracks an incorrect answer in the final score and missed_questions', async () => {
    const app = buildTestApp();
    let current = await (await postJson(app, '/api/sessions', { user_id: 'u1' })).json();
    const firstQuestion = current.question;
    const wrongIndex = (firstQuestion.correct_option + 1) % firstQuestion.options.length;

    let last = await (
      await postJson(app, `/api/sessions/${current.session_id}/next-step`, {
        user_id: 'u1',
        question_id: current.question.id,
        option_index: wrongIndex,
      })
    ).json();
    current = last;

    for (let i = 1; i < 10; i++) {
      last = await (
        await postJson(app, `/api/sessions/${current.session_id}/next-step`, {
          user_id: 'u1',
          question_id: current.question.id,
          option_index: current.question.correct_option,
        })
      ).json();
      current = last;
    }

    expect(last.score).toEqual({ correct: 9, total: 10 });
    expect(last.missed_questions).toEqual([
      {
        question: firstQuestion,
        correct_answer: firstQuestion.options[firstQuestion.correct_option],
      },
    ]);
  });
});
