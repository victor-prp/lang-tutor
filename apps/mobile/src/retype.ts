import type { Question, TypedTranslationQuestion } from '@lang-tutor/core/api';
import { evaluate, judgeTyped } from '@lang-tutor/core/domain';

/**
 * Phase 55 (spec D7). The retype: after a first typed translation whose text is
 * wrong or nearly right, the card shows the right answer and asks for the word
 * again, before any banner. The answer hides once typing starts. Right is
 * `judgeTyped`'s `exact`; a wrong first retype shows the answer again for a
 * second, and a wrong second ends it `failed`. Retypes are checked here and
 * never sent: the grade is the first answer's.
 */
export type Retype = { attempt: 1 | 2; showing: boolean; outcome: 'right' | 'failed' | null };

/** The text's own verdict decides, without `helped`: a helped right answer
 *  has its banner, and a helped wrong one is a wrong one. */
export function opensRetype(question: Question, text: string): boolean {
  if (question.type !== 'typed_translation') return false;
  const verdict = evaluate(question, { text }).verdict;
  return verdict === 'wrong' || verdict === 'near_miss';
}

export function startRetype(): Retype {
  return { attempt: 1, showing: true, outcome: null };
}

/** The first character typed hides the right answer. */
export function retypeTyping(retype: Retype): Retype {
  return retype.outcome === null && retype.showing ? { ...retype, showing: false } : retype;
}

export function retypeChecked(retype: Retype, question: TypedTranslationQuestion, text: string): Retype {
  if (retype.outcome !== null) return retype;
  const right = judgeTyped({ answer: question.answer, lemma: question.lemma, alternatives: question.alternatives }, text) === 'exact';
  if (right) return { ...retype, showing: false, outcome: 'right' };
  return retype.attempt === 1 ? { attempt: 2, showing: true, outcome: null } : { attempt: 2, showing: false, outcome: 'failed' };
}
