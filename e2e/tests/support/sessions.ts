import type { CreateSessionResponse, CurrentSessionResponse, NextStepResponse, Question, SessionView } from '@lang-tutor/core/api';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

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
 * Phase 54. Skips a list session stocked before every word of a burst of saves
 * was in, so the next one holds them all. The seed's start asks for a stock
 * (phase 43), and that job can land between two saves made a moment apart: it
 * then holds only the first word. A learner never saves that fast; a spec does.
 */
export async function retireStock(request: APIRequestContext): Promise<void> {
  const enrollmentId = await enrollmentIdOf(request);
  const res = await request.get(`${API_URL}/api/enrollments/${enrollmentId}/sessions/current`);
  expect(res.ok(), await res.text()).toBe(true);
  const { current } = (await res.json()) as CurrentSessionResponse;
  if (current && current.source === 'list' && current.answered === 0) await skipSession(request, current.session_id);
}

/**
 * Phase 31. The enrollment's next list session, made over the API and waited
 * for. An enrollment's first session is the seed, which is skipped unplayed.
 * Needs a generation stub registered (cards.ts' expectGeneration).
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
 * The form a one-word session asks about. A word with no memory yet is met
 * first (phase 54) and then asked as a choice of meanings, and a word recalled
 * well enough a typed meaning; each shows the form as `question` (phase 35,
 * domain/plan.ts).
 */
export function askedForm(question: Question): string {
  if (question.type === 'meet' || question.type === 'multiple_choice' || question.type === 'typed_meaning' || question.type === 'new_meaning') return question.question;
  throw new Error(`a one-word session asked a ${question.type} card`);
}

/**
 * Answers a new word's four cards right over the API, as the app does: the
 * meet card is seen (phase 54), the choices take their right option and the
 * typed translation its word. Returns the last response, which completes a
 * session of nothing else.
 */
export async function answerLadderRight(
  request: APIRequestContext,
  sessionId: string,
  first: Question,
): Promise<NextStepResponse> {
  let question = first;
  for (;;) {
    let data: object;
    if (question.type === 'meet') data = { question_id: question.id, seen: true };
    else if (question.type === 'multiple_choice' || question.type === 'reverse_choice') data = { question_id: question.id, option_index: question.correct_option };
    else if (question.type === 'typed_translation') data = { question_id: question.id, text: question.answer };
    else throw new Error(`a new word's ladder asked a ${question.type} card`);
    const res = await request.post(`${API_URL}/api/sessions/${sessionId}/next-step`, { data });
    expect(res.ok(), await res.text()).toBe(true);
    const next = (await res.json()) as NextStepResponse;
    if (next.complete) return next;
    question = next.question;
  }
}

/**
 * Phase 54. Taps through the meet card on screen: it asks nothing, so no banner
 * follows, and the counter moves on once the server has answered.
 */
export async function continueMeet(page: Page): Promise<void> {
  const counter = page.getByTestId('progress-label');
  const before = await counter.textContent();
  await page.getByTestId('meet-continue').click();
  await expect(counter).not.toHaveText(before ?? '');
}
