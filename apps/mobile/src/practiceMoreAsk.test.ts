import { describe, expect, it } from '@jest/globals';

import { createPracticeMoreAskStore } from './practiceMoreAsk';

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

describe('createPracticeMoreAskStore', () => {
  it('asks by default', async () => {
    const store = createPracticeMoreAskStore(fakeStorage(), 'p:');
    expect(await store.shouldAsk('dana')).toBe(true);
  });

  it('stops asking after stopAsking, and asks again after askAgain', async () => {
    const store = createPracticeMoreAskStore(fakeStorage(), 'p:');
    await store.stopAsking('dana');
    expect(await store.shouldAsk('dana')).toBe(false);
    await store.askAgain('dana');
    expect(await store.shouldAsk('dana')).toBe(true);
  });

  it('keeps the choice per username', async () => {
    const store = createPracticeMoreAskStore(fakeStorage(), 'p:');
    await store.stopAsking('dana');
    expect(await store.shouldAsk('yoni')).toBe(true);
  });

  it('asks when the storage throws, and never throws itself', async () => {
    const broken = {
      getItem: async (): Promise<string | null> => {
        throw new Error('disk');
      },
      setItem: async (): Promise<void> => {
        throw new Error('disk');
      },
    };
    const store = createPracticeMoreAskStore(broken, 'p:');
    expect(await store.shouldAsk('dana')).toBe(true);
    await expect(store.stopAsking('dana')).resolves.toBeUndefined();
    await expect(store.askAgain('dana')).resolves.toBeUndefined();
  });
});
