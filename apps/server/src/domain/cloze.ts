/**
 * Phase 27 (spec D7, phase 24 D8). Where a word sits in a sentence: the first
 * candidate that occurs exactly once as whole words, ignoring case. Letters,
 * marks and digits are word characters in any script; a multi-word candidate
 * matches its words in order across any run of spaces. Offsets are JavaScript
 * string indices into `sentence`.
 */
const WORD = '[\\p{L}\\p{M}\\p{N}]';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

export function findGap(sentence: string, candidates: readonly string[]): { start: number; end: number } | null {
  for (const candidate of candidates) {
    const words = candidate.trim().split(/\s+/u).filter(Boolean);
    if (words.length === 0) continue;
    const pattern = new RegExp(`(?<!${WORD})${words.map(escape).join('\\s+')}(?!${WORD})`, 'giu');
    const found = [...sentence.matchAll(pattern)];
    if (found.length === 1) {
      const start = found[0].index!;
      return { start, end: start + found[0][0].length };
    }
  }
  return null;
}
