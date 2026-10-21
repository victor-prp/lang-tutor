import type { Dimension, GradableAnswer, QuestionType } from '@lang-tutor/core/domain';

import { RUNGS } from './plan';
import { servedSkill } from './targetDay';

/**
 * Phase 68 (spec D1). What a target's path owes after a miss: per word and practised skill, a
 * step-down while its latest answer to a card of that skill was a miss and no right answer to the
 * skill's produce card came after it. The next session asks it as see it, pick it, produce it
 * (plan.ts). Pure (ADR 0001): the caller reads the path's answers, every day's, in answer order.
 */

export type StepDown = { glossId: string; dimension: Dimension };

/** Phase 67 (spec D2). The rung a practised skill is asked at: writing recalled (translate, gap or
 *  sentence), spelling as a dictation (typed when the device cannot listen, planCards' fallback),
 *  speaking said. */
export const rungOf = (dimension: Dimension): 1 | 2 => (dimension === 'spelling' ? 1 : 2);

/** Spec D1. Whether `type` is `dimension`'s produce card: one of its rung's types, as the picker
 *  asks it (writing a translation, gap or sentence; spelling a dictation; speaking a say). */
export const produces = (type: QuestionType, dimension: Dimension): boolean => RUNGS[dimension][rungOf(dimension) - 1].includes(type);

/** Spec D1. A miss: a wrong choice, or a text answer judged wrong or given up (help folds into
 *  wrong when the answer is decoded, phase 63). A near miss, an alternative and a skip are not. */
const missed = (answer: GradableAnswer) =>
  answer.correct === false || answer.verdict === 'wrong' || answer.verdict === 'gave_up';

/** A right answer: a right choice, or exact, near miss or understood. */
const right = (answer: GradableAnswer) =>
  answer.correct === true || answer.verdict === 'exact' || answer.verdict === 'near_miss' || answer.verdict === 'understood';

/**
 * Spec D1. The open step-downs of `answers` (the path's, in answer order), oldest miss first. An
 * intro card is encoding, not evidence (phase 55), and a card that serves no practised skill opens
 * nothing. `unanswered`: the session in flight's cards not answered yet, credited as answered right
 * after every answer, as the picker credits them.
 */
export function openStepDowns(input: {
  answers: readonly (GradableAnswer & { glossId: string })[];
  unanswered: readonly { glossId: string; type: QuestionType; intro: boolean }[];
}): StepDown[] {
  /** `glossId|dimension` → the index of its latest miss, in insertion order of that miss. */
  const open = new Map<string, { step: StepDown; at: number }>();
  input.answers.forEach((answer, at) => {
    const dimension = servedSkill(answer.type);
    if (answer.intro || dimension === null) return;
    const key = `${answer.glossId}|${dimension}`;
    if (missed(answer)) {
      open.delete(key);
      open.set(key, { step: { glossId: answer.glossId, dimension }, at });
    } else if (right(answer) && produces(answer.type, dimension)) {
      open.delete(key);
    }
  });
  for (const card of input.unanswered) {
    const dimension = servedSkill(card.type);
    if (!card.intro && dimension !== null && produces(card.type, dimension)) open.delete(`${card.glossId}|${dimension}`);
  }
  return [...open.values()].sort((a, b) => a.at - b.at).map((entry) => entry.step);
}
