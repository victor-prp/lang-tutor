/** Phase 27 (spec D5). A sentence cut around its gap: the part before, the
 *  gap's word, the part after. The offsets are the server's, validated against
 *  the sentence before it was stored. */
export function splitAtGap(
  sentence: string,
  gap: { start: number; end: number },
): { before: string; word: string; after: string } {
  return { before: sentence.slice(0, gap.start), word: sentence.slice(gap.start, gap.end), after: sentence.slice(gap.end) };
}

/** Phase 27 (spec D5). Whether a gap card shows its Hebrew line: a choice card
 *  holds it back until the answer, as it hints which word fits; a typed card
 *  always shows it, as it fixes the inflection to type. */
export function showsSentenceTranslation(type: 'cloze_choice' | 'cloze_typed', answered: boolean): boolean {
  return type === 'cloze_typed' || answered;
}
