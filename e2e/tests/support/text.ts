/** U+2066 LEFT-TO-RIGHT ISOLATE, U+2069 POP DIRECTIONAL ISOLATE. */
const ISOLATE_CHARS = /[⁦⁩]/g;

/**
 * strings.ts wraps bidirectional-ambiguous labels ("1 / 10") in Unicode
 * isolates so Android does not render them reversed under RTL. They are
 * invisible but present in textContent, so every comparison against a
 * human-readable string has to remove them first.
 */
export function stripIsolates(text: string | null): string {
  return (text ?? '').replace(ISOLATE_CHARS, '').trim();
}
