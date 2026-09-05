import { describe, expect, it } from '@jest/globals';

import { requireEnvValue } from './requireEnvValue';

describe('requireEnvValue', () => {
  it('returns the value when present', () => {
    expect(requireEnvValue('https://api.example.com', 'EXPO_PUBLIC_API_URL')).toBe(
      'https://api.example.com',
    );
  });

  it('throws naming the variable when the value is undefined', () => {
    expect(() => requireEnvValue(undefined, 'EXPO_PUBLIC_API_URL')).toThrow(
      'EXPO_PUBLIC_API_URL is not set',
    );
  });

  it('throws when the value is an empty string', () => {
    expect(() => requireEnvValue('', 'EXPO_PUBLIC_API_URL')).toThrow('EXPO_PUBLIC_API_URL is not set');
  });
});
