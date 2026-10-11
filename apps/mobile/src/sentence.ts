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
 *  holds it back until the answer, as it hints which word fits. Phase 38 (spec
 *  D1): a typed card too, unless the learner opened the hint or a second try is
 *  pending, since the Hebrew alone gives the word away. */
export function showsSentenceTranslation(
  type: 'cloze_choice' | 'cloze_typed',
  { answered, hintOpen, retrying }: { answered: boolean; hintOpen: boolean; retrying: boolean },
): boolean {
  return answered || (type === 'cloze_typed' && (hintOpen || retrying));
}
