import type { SenseProgress, SessionProgressItem } from '@lang-tutor/core/api';
import { DIMENSIONS, MAX_LEVEL, type Dimension } from '@lang-tutor/core/domain';

/** Phase 20. The screens' progress rules, as pure functions the tests can reach. */

/** Which of the five pips a level fills. */
export function pipsFor(level: number): boolean[] {
  return Array.from({ length: MAX_LEVEL }, (_, i) => i < level);
}

export type PractisedRow = SessionProgressItem & { raised: boolean };

/** The results' practised words: the ones that moved up first, then the rest,
 *  each group in the order the session asked them. */
export function practisedRows(progress: SessionProgressItem[]): PractisedRow[] {
  const rows = progress.map((item) => ({ ...item, raised: item.level_after > item.level_before }));
  return [...rows.filter((row) => row.raised), ...rows.filter((row) => !row.raised)];
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

/** Tapping the selected level clears the filter; tapping another selects it. */
export function nextLevelFilter(current: number | null, tapped: number): number | null {
  return current === tapped ? null : tapped;
}
