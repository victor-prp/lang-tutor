/** Phase 29 (spec D19). What the sign-in screens need to know, pure. */
export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`sign-in failed with ${status}${code ? ` (${code})` : ''}`);
    this.name = 'AuthError';
  }
}

export type SignInProblem =
  | 'wrong_code'
  | 'new_code_needed'
  | 'too_many_codes'
  | 'email_not_sent'
  | 'invalid_email'
  | 'server_error'
  | 'network';

/** "Send a new code" unlocks this long after the last one. */
export const RESEND_AFTER_MS = 30_000;

export const cleanCode = (value: string): string => value.replace(/\s/g, '');
export const isCode = (value: string): boolean => /^\d{8}$/.test(cleanCode(value));

export function signInProblem(error: unknown): SignInProblem {
  if (!(error instanceof AuthError)) return 'network';
  if (error.code === 'INVALID_OTP') return 'wrong_code';
  if (error.code === 'OTP_EXPIRED' || error.code === 'TOO_MANY_ATTEMPTS') return 'new_code_needed';
  if (error.status === 429) return 'too_many_codes';
  if (error.status === 503) return 'email_not_sent';
  // A 400 the codes above do not explain is the address (malformed, or one
  // nothing is sent to). Anything else unexplained — another 5xx, a 403 with
  // no code we know — is not the learner's doing, so they are told to retry.
  if (error.status === 400) return 'invalid_email';
  return 'server_error';
}
