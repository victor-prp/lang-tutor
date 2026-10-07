import type { MissedQuestion, SenseProgress, SessionProgressItem } from '@lang-tutor/core/api';
import { DIMENSIONS, MAX_LEVEL, type Dimension } from '@lang-tutor/core/domain';

/** Phase 20. The screens' progress rules, as pure functions the tests can reach. */

/** Which of the five pips a level fills. */
export function pipsFor(level: number): boolean[] {
  return Array.from({ length: MAX_LEVEL }, (_, i) => i < level);
}

/** `badgeRaised`: the badge moved up. `progressed` (phase 23): it did not, but
 *  a dimension did, which the row names (spec D11). The wire's `raised` is the
 *  list of those dimensions. */
export type PractisedRow = SessionProgressItem & { badgeRaised: boolean; progressed: boolean };

/** The results' practised words: the ones whose badge moved up first, then the
 *  ones that moved a dimension, then the rest, each group in session order. */
export function practisedRows(progress: SessionProgressItem[]): PractisedRow[] {
  const rows = progress.map((item) => {
    const badgeRaised = item.level_after > item.level_before;
    return { ...item, badgeRaised, progressed: !badgeRaised && item.raised.length > 0 };
  });
  return [
    ...rows.filter((row) => row.badgeRaised),
    ...rows.filter((row) => row.progressed),
    ...rows.filter((row) => !row.badgeRaised && !row.progressed),
  ];
}

export type DimensionRow = { dimension: Dimension; level: number | null };

/** A saved sense's five dimensions in a fixed order. `level` is null for a
 *  dimension no exercise feeds yet, which the screen shows as not practised. */
export function dimensionRows(progress: SenseProgress, live: readonly Dimension[]): DimensionRow[] {
  return DIMENSIONS.map((dimension) => ({
    dimension,
    level: live.includes(dimension) ? progress.dimensions[dimension] : null,
  }));
}

/** Phase 23. A missed row reads word → meaning whichever way the card asked:
 *  today's card prompts with the word, a reversed or typed one with the
 *  meaning. */
export function missedPair({ question, correct_answer }: MissedQuestion): { word: string; meaning: string } {
  return question.type === 'multiple_choice'
    ? { word: question.question, meaning: correct_answer }
    : { word: correct_answer, meaning: question.question };
}
