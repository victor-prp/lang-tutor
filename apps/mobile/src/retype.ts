import type { Question } from '@lang-tutor/core/api';
import { evaluate, normaliseHebrew } from '@lang-tutor/core/domain';

import type { CardAnswer } from '@/feedback';

/**
 * Phase 55 (spec D7). The retype: after a first typed translation whose text is
 * wrong or nearly right, the card shows the right answer and asks for the word
 * again, before any banner. The answer hides once typing starts. Right is
 * `judgeTyped`'s `exact`; a wrong first retype shows the answer again for a
 * second, and a wrong second ends it `failed`. Retypes are checked here and
 * never sent: the grade is the first answer's.
 */
export type Retype = { attempt: 1 | 2; showing: boolean; outcome: 'right' | 'failed' | null };

/** Phase 56 (spec D7). The cards the phone judges whose first answer opens a
 *  retype; a typed meaning opens one by the judge's verdict. */
const RETYPED: ReadonlySet<Question['type']> = new Set(['typed_translation', 'dictation', 'cloze_typed', 'say_translation']);

/** The text's own verdict decides, without `helped`: a helped right answer
 *  has its banner, and a helped wrong one is a wrong one. Phase 56 (spec D7): on
 *  a typed meaning, the judge's; never on a sentence translation. */
export function opensRetype(question: Question, answer: CardAnswer): boolean {
  if ('judged' in answer) return question.type === 'typed_meaning' && (answer.judged === 'wrong' || answer.judged === 'near_miss');
  if (!('text' in answer) || !RETYPED.has(question.type)) return false;
  const verdict = evaluate(question, { text: answer.text }).verdict;
  return verdict === 'wrong' || verdict === 'near_miss';
}

/** Phase 56 (spec D7). Whether a retype is the card's own answer: a typed
 *  meaning's stored meaning as the banner compares it, without niqqud or
 *  marks; on every other card, the card's own `exact` (the form or its lemma,
 *  the heard form alone, the gap's word). Another accepted word is not it. */
export function retypeRight(question: Question, text: string): boolean {
  if (question.type === 'typed_meaning') return normaliseHebrew(text) === normaliseHebrew(question.meaning);
  if (!RETYPED.has(question.type)) return false;
  return evaluate(question, { text }).verdict === 'exact';
}

export function startRetype(): Retype {
  return { attempt: 1, showing: true, outcome: null };
}

/** The first character typed hides the right answer. */
export function retypeTyping(retype: Retype): Retype {
  return retype.outcome === null && retype.showing ? { ...retype, showing: false } : retype;
}

export function retypeChecked(retype: Retype, question: Question, text: string): Retype {
  if (retype.outcome !== null) return retype;
  if (retypeRight(question, text)) return { ...retype, showing: false, outcome: 'right' };
  return retype.attempt === 1 ? { attempt: 2, showing: true, outcome: null } : { attempt: 2, showing: false, outcome: 'failed' };
}
