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

/** Phase 24. What a card was answered with: an option, a text, or a board's
 *  first tries (spec D10). */
export type CardAnswer = AnswerInput | { board: number[] };

/**
 * Phase 23. The banner after an answer. It runs the same `evaluate` the server
 * runs, so what the learner is told is what the server records (spec D9).
 */
export function feedbackFor(question: Question, answer: CardAnswer): Feedback {
  if ('board' in answer) {
    if (question.type !== 'matching') throw new Error(`a board answer for a ${question.type} card`);
    const start = question.board.question_ids.indexOf(question.id);
    const right = answer.board.filter((meaning, i) => meaning === question.board.correct_options[start + i]).length;
    return {
      tone: right === answer.board.length ? 'correct' : 'wrong',
      title: strings.boardResult(right, answer.board.length),
      line: null,
      verdict: null,
    };
  }
  const record = evaluate(question, answer);
  const verdict = record.verdict ?? null;
  const right = rightAnswer(question);
  if (!record.is_correct) return { tone: 'wrong', title: strings.feedbackWrong, line: right, verdict };
  if (verdict === 'near_miss') return { tone: 'correct', title: strings.feedbackNearMiss, line: right, verdict };
  if (verdict === 'alternative') return { tone: 'correct', title: strings.feedbackAlternative, line: right, verdict };
  return { tone: 'correct', title: strings.feedbackCorrect, line: null, verdict };
}
