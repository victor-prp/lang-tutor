import { describe, expect, it } from '@jest/globals';

import { AuthError, cleanCode, isCode, signInProblem } from './signIn';

describe('signInProblem', () => {
  it.each([
    [new AuthError(400, 'INVALID_OTP'), 'wrong_code'],
    [new AuthError(400, 'OTP_EXPIRED'), 'new_code_needed'],
    [new AuthError(403, 'TOO_MANY_ATTEMPTS'), 'new_code_needed'],
    [new AuthError(429), 'too_many_codes'],
    [new AuthError(503), 'email_not_sent'],
    [new AuthError(400), 'invalid_email'],
    [new TypeError('Network request failed'), 'network'],
  ])('maps %p to %s', (error, problem) => {
    expect(signInProblem(error)).toBe(problem);
  });
});

describe('the code field', () => {
  it('accepts 8 digits with or without the space the email shows', () => {
    expect(isCode('12345678')).toBe(true);
    expect(isCode('1234 5678')).toBe(true);
    expect(isCode('1234567')).toBe(false);
    expect(isCode('1234567a')).toBe(false);
    expect(cleanCode(' 1234 5678 ')).toBe('12345678');
  });
});
