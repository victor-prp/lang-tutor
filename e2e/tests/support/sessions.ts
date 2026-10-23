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

/** Phase 73 (spec D6). The seed, made over the API and left ready to play: home's card never
 *  starts it, and create answers it only for an enrollment with no session and no saved word.
 *  Home then offers it as any ready session, so a spec about the seed's fixed cards enters it
 *  with the card's button. */
export async function makeSeed(request: APIRequestContext, enrollmentId: string): Promise<string> {
  const made = await request.post(`${API_URL}/api/sessions`, { data: { enrollment_id: enrollmentId } });
  expect(made.ok(), await made.text()).toBe(true);
  const created = (await made.json()) as CreateSessionResponse;
  expect(created.source, JSON.stringify(created)).toBe('seed');
  return created.session_id;
}

/** An enrollment's first session is the seed: made and skipped unplayed, so a spec starts
 *  past it. Phase 73 (spec D6): only a real seed. An enrollment with a word of its own has none
 *  to pass, and create would answer its first list session, which is left alone. */
export async function skipSeed(request: APIRequestContext, enrollmentId: string): Promise<void> {
  if ((await readCurrent(request, enrollmentId)).next_source !== 'seed') return;
  await skipSession(request, await makeSeed(request, enrollmentId));
}

/** Phase 57 (spec D1). A path's current session: a target's with `targetId`, else My
 *  words' (the main path). */
export async function readCurrent(
  request: APIRequestContext,
  enrollmentId: string,
  targetId?: string,
): Promise<CurrentSessionResponse> {
  const query = targetId ? `?target_id=${targetId}` : '';
  const res = await request.get(`${API_URL}/api/enrollments/${enrollmentId}/sessions/current${query}`);
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as CurrentSessionResponse;
}

/** Phase 57 (spec D2). A path's session once it is ready to play, a target's with
 *  `targetId`, else My words': its stock, made as its words came or as its last session
 *  started. Needs a generation stub registered (cards.ts' expectGeneration). */
export async function readyPathSession(request: APIRequestContext, enrollmentId: string, targetId?: string): Promise<string> {
  let sessionId = '';
  await expect(async () => {
    const { current } = await readCurrent(request, enrollmentId, targetId);
    expect(current?.status, JSON.stringify(current)).toBe('ready');
    sessionId = current!.session_id;
  }).toPass({ timeout: 60_000 });
  return sessionId;
}

/**
 * Phase 54. Skips a list session stocked before every word of a burst of saves
 * was in, so the next one holds them all. The seed's start asks for a stock
 * (phase 43), and that job can land between two saves made a moment apart: it
 * then holds only the first word. A learner never saves that fast; a spec does.
 */
export async function retireStock(request: APIRequestContext): Promise<void> {
  const { current } = await readCurrent(request, await enrollmentIdOf(request));
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
 * Answers a new word's ladder right over the API, as the app does: the meet
 * card is seen (phase 54), the choices take their right option, and the tiles
 * and the typed translation the word, with no help (phase 55, spec D6). A
 * session made over the API says nothing of speaking, so its ladder has no read
 * aloud. Returns the last response, which completes a session of nothing else.
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
    else if (question.type === 'letter_tiles' || question.type === 'typed_translation') data = { question_id: question.id, text: question.answer, helped: false };
    else throw new Error(`a new word's ladder asked a ${question.type} card`);
    const res = await request.post(`${API_URL}/api/sessions/${sessionId}/next-step`, { data });
    expect(res.ok(), await res.text()).toBe(true);
    const next = (await res.json()) as NextStepResponse;
    if (next.complete) return next;
    question = next.question;
  }
}

/** Phase 57. Answers a whole ready session right over the API: every card is one of a new
 *  word's ladder, which is all a session of new words asks (a target's first, spec D7). */
export async function answerSessionRight(request: APIRequestContext, sessionId: string): Promise<void> {
  const res = await request.get(`${API_URL}/api/sessions/${sessionId}`);
  expect(res.ok(), await res.text()).toBe(true);
  const view = (await res.json()) as SessionView;
  expect(view.question, JSON.stringify(view)).not.toBeNull();
  expect((await answerLadderRight(request, sessionId, view.question!)).complete).toBe(true);
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
