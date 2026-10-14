import { shuffle } from './session';

/** Phase 48 (spec D3). The fewest cards a session keeps, or every planned card when fewer were planned. */
export const MIN_SESSION_CARDS = 6;

export type Refusal = { stage: 'validation' | 'checker'; reason: string };

/** A single card, or a board's four, by plan index; refused or not. */
export type CardUnit = { indexes: number[]; refusal: Refusal | null };

export type CardFate =
  | { index: number; fate: 'keep' }
  | { index: number; fate: 'keep_refused'; shownAs: 'as_generated' | 'typed_translation'; refusal: Refusal }
  | { index: number; fate: 'drop'; refusal: Refusal };

/**
 * Phase 48 (spec D3). A unit nobody refused is kept, and a refused one dropped,
 * unless the session would then hold fewer than MIN_SESSION_CARDS: refused units
 * are then kept anyway, in a random order, those the checker refused first (an
 * ambiguous card, shown as generated) and those validation refused after (no
 * three showable options, so a typed translation). A unit is kept or dropped
 * whole, so a board can take the count past the floor. `rng` is drawn only
 * when a fill is needed.
 */
export function keepCards(units: readonly CardUnit[], rng: () => number): CardFate[] {
  const planned = units.reduce((sum, unit) => sum + unit.indexes.length, 0);
  const target = Math.min(MIN_SESSION_CARDS, planned);
  let count = units.filter((unit) => unit.refusal === null).reduce((sum, unit) => sum + unit.indexes.length, 0);
  const filled = new Set<CardUnit>();
  if (count < target) {
    const refused = (stage: Refusal['stage']) => units.filter((unit) => unit.refusal?.stage === stage);
    for (const unit of [...shuffle(refused('checker'), rng), ...shuffle(refused('validation'), rng)]) {
      if (count >= target) break;
      filled.add(unit);
      count += unit.indexes.length;
    }
  }
  return units
    .flatMap((unit): CardFate[] =>
      unit.indexes.map((index): CardFate => {
        if (unit.refusal === null) return { index, fate: 'keep' };
        if (!filled.has(unit)) return { index, fate: 'drop', refusal: unit.refusal };
        return { index, fate: 'keep_refused', shownAs: unit.refusal.stage === 'checker' ? 'as_generated' : 'typed_translation', refusal: unit.refusal };
      }),
    )
    .sort((a, b) => a.index - b.index);
}
