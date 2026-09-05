import { describe, expect, it } from '@jest/globals';

import { createUserIdStore } from './userId';

function fakeStorage(initial: Record<string, string> = {}) {
  const values = { ...initial };
  return {
    values,
    getItem: async (key: string) => values[key] ?? null,
    setItem: async (key: string, value: string) => {
      values[key] = value;
    },
  };
}

describe('getOrCreateUserId', () => {
  it('generates and persists an id on first call', async () => {
    const storage = fakeStorage();
    let n = 0;
    const store = createUserIdStore({ storage, randomUUID: () => `test-uuid-${++n}` });

    expect(await store.getOrCreateUserId()).toBe('test-uuid-1');
    expect(storage.values['lang-tutor:user-id']).toBe('test-uuid-1');
  });

  it('returns the persisted id on later calls without generating a new one', async () => {
    const storage = fakeStorage({ 'lang-tutor:user-id': 'existing-id' });
    const store = createUserIdStore({
      storage,
      randomUUID: () => {
        throw new Error('must not generate when an id is already stored');
      },
    });

    expect(await store.getOrCreateUserId()).toBe('existing-id');
    expect(await store.getOrCreateUserId()).toBe('existing-id');
  });

  it('returns the same id on a second call instead of generating a new one', async () => {
    const storage = fakeStorage();
    let n = 0;
    const store = createUserIdStore({ storage, randomUUID: () => `test-uuid-${++n}` });

    const first = await store.getOrCreateUserId();
    const second = await store.getOrCreateUserId();
    expect(second).toBe(first);
  });
});
