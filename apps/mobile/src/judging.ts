import type { JudgedAnswerResponse, TypedVerdict } from '@lang-tutor/core/api';

/** Phase 27 (spec D13). A judged card's check: none yet, in flight, or failed
 *  (the card keeps the text, and "try again" sends it again). */
export type JudgeAttempt = 'idle' | 'checking' | 'failed';

/** Whether a submit may start: an unanswered card, not already checking. */
export function canJudge(attempt: JudgeAttempt, answered: boolean): boolean {
  return !answered && attempt !== 'checking';
}

/** The answer a judged response sets on the card. */
export function judgedAnswer(text: string, response: JudgedAnswerResponse): { text: string; judged: TypedVerdict } {
  return { text, judged: response.verdict };
}
