import { describe, expect, it } from '@jest/globals';

import { CODE_SENDS_PER_HOUR, isDeliverable, mayRequestCode, normalizeEmail } from './auth';

describe('mayRequestCode', () => {
  it('allows up to five sends in the window and refuses the sixth', () => {
    expect(CODE_SENDS_PER_HOUR).toBe(5);
    expect(mayRequestCode(0)).toBe(true);
    expect(mayRequestCode(4)).toBe(true);
    expect(mayRequestCode(5)).toBe(false);
    expect(mayRequestCode(6)).toBe(false);
  });
});

describe('normalizeEmail', () => {
  it('trims and lower-cases, so one address is one account and one budget', () => {
    expect(normalizeEmail('  Victor@Example.COM ')).toBe('victor@example.com');
  });
});

describe('isDeliverable', () => {
  it('refuses the reserved .invalid domain the migration uses for unclaimed accounts', () => {
    expect(isDeliverable('abc@unclaimed.invalid')).toBe(false);
    expect(isDeliverable('ABC@UNCLAIMED.INVALID')).toBe(false);
    expect(isDeliverable('learner@example.com')).toBe(true);
  });
});
