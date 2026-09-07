import { describe, expect, it } from '@jest/globals';

import { createRememberedUsernameStore } from './currentUser';

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

describe('createRememberedUsernameStore', () => {
  it('reads an empty string when nothing has been remembered', async () => {
    const store = createRememberedUsernameStore({ storage: fakeStorage() });
    expect(await store.read()).toBe('');
  });

  it('reads back what was written', async () => {
    const storage = fakeStorage();
    const store = createRememberedUsernameStore({ storage });

    await store.write('dana');

    expect(await store.read()).toBe('dana');
    expect(storage.values['lang-tutor:username']).toBe('dana');
  });

  it('overwrites the previous username rather than accumulating', async () => {
    const storage = fakeStorage({ 'lang-tutor:username': 'dana' });
    const store = createRememberedUsernameStore({ storage });

    await store.write('yoni');

    expect(await store.read()).toBe('yoni');
  });
});
