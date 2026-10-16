import type { Mark } from '@lang-tutor/core/api';

/** Phase 59 (spec D3). A word of a sentence translation's map, as the card is served it. */
export type ServedWord = { start: number; end: number; text: string; target: boolean };

/** One run of the Hebrew sentence: plain text, or a word a tap shows the Italian
 *  of, by its index in the map (`'mark'`: the practised word on a card with no map). */
export type Run =
  | { text: string; tap: null }
  | { text: string; tap: number | 'mark'; translation: string | null; target: boolean };

const fits = (run: { start: number; end: number }, text: string) =>
  Number.isInteger(run.start) && Number.isInteger(run.end) && run.start >= 0 && run.start < run.end && run.end <= text.length;

/**
 * Phase 59 (spec D3). The sentence cut into its runs, in order: each word of the
 * map, or with no map the mark alone. A run the sentence cannot hold, or that
 * overlaps one before it, is left as plain text, never cut wrongly.
 */
export function tappableRuns(text: string, words: readonly ServedWord[] | null | undefined, mark: Mark | null): Run[] {
  const tappable: { start: number; end: number; tap: number | 'mark'; translation: string | null; target: boolean }[] = words
    ? words.map((word, index) => ({ start: word.start, end: word.end, tap: index, translation: word.text, target: word.target }))
    : mark
      ? [{ start: mark.start, end: mark.end, tap: 'mark' as const, translation: null, target: true }]
      : [];
  const runs: Run[] = [];
  let at = 0;
  for (const run of tappable) {
    if (!fits(run, text) || run.start < at) continue;
    if (run.start > at) runs.push({ text: text.slice(at, run.start), tap: null });
    runs.push({ text: text.slice(run.start, run.end), tap: run.tap, translation: run.translation, target: run.target });
    at = run.end;
  }
  if (at < text.length) runs.push({ text: text.slice(at), tap: null });
  return runs;
}
