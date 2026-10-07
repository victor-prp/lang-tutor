import type { Question, TypedVerdict } from '@lang-tutor/core/api';
import { evaluate, rightAnswer, type AnswerInput } from '@lang-tutor/core/domain';

import { strings } from '@/strings';

/** What the banner says after an answer. `tone` picks its colours; a near miss
 *  and an alternative count as correct, so they are `correct`. */
export type Feedback = {
  tone: 'correct' | 'wrong';
  title: string;
  line: string | null;
  verdict: TypedVerdict | null;
};

/**
 * Phase 23. The banner after an answer. It runs the same `evaluate` the server
 * runs, so what the learner is told is what the server records (spec D9).
 */
export function feedbackFor(question: Question, answer: AnswerInput): Feedback {
  const record = evaluate(question, answer);
  const verdict = record.verdict ?? null;
  const right = rightAnswer(question);
  if (!record.is_correct) return { tone: 'wrong', title: strings.feedbackWrong, line: right, verdict };
  if (verdict === 'near_miss') return { tone: 'correct', title: strings.feedbackNearMiss, line: right, verdict };
  if (verdict === 'alternative') return { tone: 'correct', title: strings.feedbackAlternative, line: right, verdict };
  return { tone: 'correct', title: strings.feedbackCorrect, line: null, verdict };
}
