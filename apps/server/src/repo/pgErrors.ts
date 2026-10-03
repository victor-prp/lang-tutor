/**
 * Drizzle 0.45 wraps a driver error in a DrizzleQueryError whose `cause` is the
 * pg error carrying `code`; other paths throw the pg error directly. Walking the
 * chain is correct under both, and stays correct if another wrapper is added.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error; current != null; ) {
    if (typeof current === 'object' && (current as { code?: unknown }).code === '23505') {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
