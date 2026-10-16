import type { MapWord } from './context';

/**
 * Phase 59 (spec D4). What a tap on a sentence translation's word costs: `target`
 * helps the card, `list` is a miss on the list word it renders, `free` nothing.
 * Pure (ADR 0001 R3).
 */
export type TapKind = 'target' | 'list' | 'free';

export type Tap = { index: number; kind: TapKind; glossId: string | null };

/** Each tapped word, in the order sent, once; an index the map has no word at is
 *  dropped, and a card with no map keeps none. */
export function classifyTaps(words: readonly MapWord[] | null, tapped: readonly number[]): Tap[] {
  if (!words) return [];
  const seen = new Set<number>();
  return tapped.flatMap((index): Tap[] => {
    const word = Number.isInteger(index) ? words[index] : undefined;
    if (!word || seen.has(index)) return [];
    seen.add(index);
    if (word.target) return [{ index, kind: 'target' as const, glossId: null }];
    return word.glossId ? [{ index, kind: 'list' as const, glossId: word.glossId }] : [{ index, kind: 'free' as const, glossId: null }];
  });
}
