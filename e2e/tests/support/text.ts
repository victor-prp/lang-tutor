/** U+2066 LEFT-TO-RIGHT ISOLATE through U+2069 POP DIRECTIONAL ISOLATE, which
 *  includes U+2068 FIRST STRONG ISOLATE: the feedback banner isolates a
 *  target-language word inside its Hebrew text (phase 23). */
const ISOLATE_CHARS = /[\u2066-\u2069]/g;

/**
 * strings.ts wraps bidirectional-ambiguous labels ("1 / 10") in Unicode
 * isolates so Android does not render them reversed under RTL. They are
 * invisible but present in textContent, so every comparison against a
 * human-readable string has to remove them first.
 */
export function stripIsolates(text: string | null): string {
  return (text ?? '').replace(ISOLATE_CHARS, '').trim();
}
