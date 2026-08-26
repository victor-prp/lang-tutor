import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// expo-crypto's own auto-generated Jest mock (expo-crypto/mocks/ExpoCrypto.ts)
// ships `randomUUID(): any {}` — an empty stub that always returns
// `undefined` — so it must be overridden here to get a real string back.
jest.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid' }));

import AsyncStorage from '@react-native-async-storage/async-storage';

import { getOrCreateUserId } from './userId';

describe('getOrCreateUserId', () => {
  it('creates and persists a UUID the first time it is called', async () => {
    const id = await getOrCreateUserId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(await AsyncStorage.getItem('lang-tutor:user-id')).toBe(id);
  });

  it('returns the same id on a second call instead of generating a new one', async () => {
    const first = await getOrCreateUserId();
    const second = await getOrCreateUserId();
    expect(second).toBe(first);
  });
});
