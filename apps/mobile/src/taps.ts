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

/** Phase 59c (design A). One word of the sentence as the card lays it out: its
 *  text, what sits right before and after it (spaces, punctuation, a letter the
 *  map left outside it) and, for a word a tap can show, its run's tap. */
export type Unit = { before: string; text: string; after: string; tap: number | 'mark' | null; translation: string | null; target: boolean };

const HAS_LETTER = /[\p{L}\p{N}]/u;

/**
 * Phase 59c (design A). The sentence as words laid out side by side, each with
 * room for its Italian under it: every run a tap shows (tappableRuns) is one
 * unit, and the plain text between them is cut into words. Spaces and
 * punctuation stay with the word before them, or the first word when nothing
 * comes before, so the units together are the sentence, letter for letter.
 */
export function sentenceUnits(text: string, words: readonly ServedWord[] | null | undefined, mark: Mark | null): Unit[] {
  const units: Unit[] = [];
  let pending = '';
  const add = (unit: Omit<Unit, 'before' | 'after'>) => {
    units.push({ before: pending, after: '', ...unit });
    pending = '';
  };
  const trail = (piece: string) => {
    const last = units[units.length - 1];
    if (last) last.after += piece;
    else pending += piece;
  };
  for (const run of tappableRuns(text, words, mark)) {
    if (run.tap !== null) {
      add({ text: run.text, tap: run.tap, translation: run.translation, target: run.target });
      continue;
    }
    // Spaces, words (Hebrew's geresh and gershayim inside them), and the rest.
    for (const token of run.text.match(/\s+|[\p{L}\p{M}\p{N}'׳״]+|[^\s\p{L}\p{M}\p{N}]+/gu) ?? []) {
      const last = units[units.length - 1];
      // A word starts a unit unless it is glued to the one before it.
      if (HAS_LETTER.test(token) && !(last && last.after === '')) {
        add({ text: token, tap: null, translation: null, target: false });
      } else {
        trail(token);
      }
    }
  }
  if (pending !== '') units.push({ before: pending, text: '', after: '', tap: null, translation: null, target: false });
  return units;
}
