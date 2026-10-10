import type { CreateSessionResponse, NextStepResponse, Question, SessionView } from '@lang-tutor/core/api';
import { expect, type APIRequestContext } from '@playwright/test';

import { API_URL } from '../../urls';

// Phase 31. A session made, read and answered over the API, as the signed-in
// learner: pass `page.request`, which carries the cookie signUpLearner set
// (phase 29).

/** Phase 31. The one enrollment signUpLearner made. */
export async function enrollmentIdOf(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${API_URL}/api/enrollments`);
  expect(res.ok(), await res.text()).toBe(true);
  const enrollments = (await res.json()) as { id: string }[];
  expect(enrollments).toHaveLength(1);
  return enrollments[0].id;
}

export async function skipSession(request: APIRequestContext, sessionId: string): Promise<void> {
  expect((await request.post(`${API_URL}/api/sessions/${sessionId}/skip`)).ok()).toBe(true);
}

/**
 * Phase 31. The enrollment's next list session, made over the API and waited
 * for. An enrollment's first session is the seed, which is skipped unplayed.
 * Needs a generation stub registered (cards.ts' generationStub).
 */
export async function readyListSession(
  request: APIRequestContext,
  enrollmentId: string,
): Promise<{ id: string; total: number; question: Question }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const made = await request.post(`${API_URL}/api/sessions`, { data: { enrollment_id: enrollmentId } });
    expect(made.ok(), await made.text()).toBe(true);
    const created = (await made.json()) as CreateSessionResponse;
    if (created.source === 'seed') {
      await skipSession(request, created.session_id);
      continue;
    }
    let view: SessionView | undefined;
    await expect(async () => {
      const res = await request.get(`${API_URL}/api/sessions/${created.session_id}`);
      expect(res.ok(), await res.text()).toBe(true);
      view = (await res.json()) as SessionView;
      expect(view.status).toBe('ready');
    }).toPass({ timeout: 60_000 });
    return { id: created.session_id, total: view!.position.total, question: view!.question! };
  }
  throw new Error('no list session after the seed');
}

/**
 * The form a one-word session asks about. With no voice and no microphone
 * declared, one pick always takes the first tier's card: a choice of meanings
 * or a typed meaning, and both show the form as `question` (domain/plan.ts).
 */
export function askedForm(question: Question): string {
  if (question.type === 'multiple_choice' || question.type === 'typed_meaning') return question.question;
  throw new Error(`a one-word session asked a ${question.type} card`);
}

/** Answers a choice of meanings right, as the app does. */
export async function answerChoiceRight(
  request: APIRequestContext,
  sessionId: string,
  question: Question,
): Promise<NextStepResponse> {
  if (question.type !== 'multiple_choice') throw new Error(`expected a choice of meanings, got ${question.type}`);
  const res = await request.post(`${API_URL}/api/sessions/${sessionId}/next-step`, {
    data: { question_id: question.id, option_index: question.correct_option },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as NextStepResponse;
}
