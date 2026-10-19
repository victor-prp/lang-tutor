import { describe, expect, it } from '@jest/globals';

import { createAskSwitch, createPracticeMoreAskStore } from './practiceMoreAsk';

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

/** A store whose reads wait until the test lets them through. */
function slowStore(stopped: boolean) {
  const pending: (() => void)[] = [];
  const writes: string[] = [];
  return {
    writes,
    release: () => pending.splice(0).forEach((resolve) => resolve()),
    store: {
      shouldAsk: (_username: string) => new Promise<boolean>((resolve) => pending.push(() => resolve(!stopped))),
      stopAsking: async (username: string) => {
        writes.push(`stop ${username}`);
      },
      askAgain: async (username: string) => {
        writes.push(`ask ${username}`);
      },
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// Phase 65 (spec D9), final review I3. The הגדרות switch reads the stored choice each time the
// screen is shown, and a flip made while a read is on its way wins over that read.
describe('createAskSwitch', () => {
  it('shows the stored choice when a read resolves', async () => {
    const slow = slowStore(true);
    const shown: boolean[] = [];
    const ask = createAskSwitch(slow.store, 'dana', (value) => shown.push(value));
    ask.read();
    slow.release();
    await settle();
    expect(shown).toEqual([false]);
  });

  it('ignores a read that resolves after the learner flipped the switch', async () => {
    const slow = slowStore(true);
    const shown: boolean[] = [];
    const ask = createAskSwitch(slow.store, 'dana', (value) => shown.push(value));
    ask.read();
    ask.flip(true);
    slow.release();
    await settle();
    expect(shown).toEqual([true]);
    expect(slow.writes).toEqual(['ask dana']);
    // A read started after the flip shows what is stored then.
    ask.read();
    slow.release();
    await settle();
    expect(shown).toEqual([true, false]);
  });

  it('ignores a read the screen stopped waiting for (it lost focus)', async () => {
    const slow = slowStore(true);
    const shown: boolean[] = [];
    const ask = createAskSwitch(slow.store, 'dana', (value) => shown.push(value));
    const stop = ask.read();
    stop();
    slow.release();
    await settle();
    expect(shown).toEqual([]);
  });

  it('writes the flip to the store', async () => {
    const slow = slowStore(false);
    const ask = createAskSwitch(slow.store, 'dana', () => undefined);
    ask.flip(false);
    ask.flip(true);
    expect(slow.writes).toEqual(['stop dana', 'ask dana']);
  });
});
