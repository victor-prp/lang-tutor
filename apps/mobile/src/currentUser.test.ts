import { describe, expect, it } from '@jest/globals';

import { createRememberedEnrollmentStore } from './currentUser';

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

describe('createRememberedEnrollmentStore', () => {
  it('remembers one enrollment per username, so two learners on one device never share one', async () => {
    const store = createRememberedEnrollmentStore({ storage: fakeStorage() });
    await store.write('dana', 'e-ru');
    await store.write('yoni', 'e-en');
    expect(await store.read('dana')).toBe('e-ru');
    expect(await store.read('yoni')).toBe('e-en');
    expect(await store.read('nobody')).toBeNull();
  });
});
