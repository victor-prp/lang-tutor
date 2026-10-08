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

/**
 * Phase 29. The name of the constraint a driver error violated, walking the
 * chain as isUniqueViolation does. Tells two unique violations on one table
 * apart: `users_pkey` (a second profile) from the username's.
 */
export function constraintOf(error: unknown): string | undefined {
  for (let current: unknown = error; current != null; ) {
    const constraint = typeof current === 'object' ? (current as { constraint?: unknown }).constraint : undefined;
    if (typeof constraint === 'string') return constraint;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
