/**
 * Phase 29 (spec D4). The rules around sending a sign-in code, pure (ADR 0001
 * R3). The count comes from auth_code_sends; the window is the caller's
 * clock minus SEND_WINDOW_MS.
 */
export const CODE_SENDS_PER_HOUR = 5;
export const SEND_WINDOW_MS = 60 * 60 * 1000;
/** Send-log rows older than this are deleted on each send. */
export const SEND_LOG_RETENTION_MS = 24 * 60 * 60 * 1000;

/** One address is one account and one send budget, whatever its case. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Only successful sends are counted, so an outage never locks anyone out. */
export const mayRequestCode = (recentSends: number): boolean => recentSends < CODE_SENDS_PER_HOUR;

/** `.invalid` is reserved (RFC 2606) and is what migration 0022 gives unclaimed accounts. */
export const isDeliverable = (email: string): boolean => !normalizeEmail(email).endsWith('.invalid');
