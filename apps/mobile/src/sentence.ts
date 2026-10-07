/** Phase 27 (spec D5). A sentence cut around its gap: the part before, the
 *  gap's word, the part after. The offsets are the server's, validated against
 *  the sentence before it was stored. */
export function splitAtGap(
  sentence: string,
  gap: { start: number; end: number },
): { before: string; word: string; after: string } {
  return { before: sentence.slice(0, gap.start), word: sentence.slice(gap.start, gap.end), after: sentence.slice(gap.end) };
}
