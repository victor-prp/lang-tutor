/**
 * Phase 27 (spec D3). Two Hebrew answers compared as: NFC, a maqaf read as a
 * space, points and cantillation removed, invisible format marks (RLM, LRM, ZWJ, ZWNJ) removed, every other punctuation mark or
 * symbol read as a space, single spaces, trimmed. Shared on purpose: the
 * server's rule ("the stored meaning, exactly") and the app's banner ("the
 * answer differs from the stored meaning") must agree.
 */
export function normaliseHebrew(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\u05BE/gu, ' ')
    .replace(/[\u0591-\u05BD\u05BF-\u05C7]/gu, '')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}
