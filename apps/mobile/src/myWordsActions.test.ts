import { describe, expect, it, jest } from '@jest/globals';

import { myWordsActions } from '@/myWordsActions';
import type { HomeAction } from '@/nextSession';

function build(create: () => Promise<unknown> = async () => ({})) {
  // Home's run swallows a failure too.
  const run = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch {
      // swallowed
    }
  };
  const fakes = {
    create: jest.fn(create),
    skipSession: jest.fn<(id: string) => Promise<void>>(async () => undefined),
    openSession: jest.fn<(id: string, fresh: boolean) => void>(),
    onDiscover: jest.fn<() => void>(),
    onSkipped: jest.fn<() => void>(),
    setMakeFailed: jest.fn<(failed: boolean) => void>(),
  };
  return { ...fakes, actions: myWordsActions({ run, ...fakes }) };
}

describe('myWordsActions press', () => {
  it('discover goes on to Words for me and nothing else', () => {
    const t = build();
    t.actions.press({ kind: 'discover' });
    expect(t.onDiscover).toHaveBeenCalledTimes(1);
    expect(t.openSession).not.toHaveBeenCalled();
    expect(t.create).not.toHaveBeenCalled();
  });

  it('start enters fresh, resume enters as it is', () => {
    const t = build();
    t.actions.press({ kind: 'start', sessionId: 's1' });
    t.actions.press({ kind: 'resume', sessionId: 's2' });
    expect(t.openSession.mock.calls).toEqual([['s1', true], ['s2', false]]);
  });

  it('create and failed send a create; preparing does nothing', async () => {
    const t = build();
    t.actions.press({ kind: 'create' });
    t.actions.press({ kind: 'failed' });
    t.actions.press({ kind: 'preparing', sessionId: 's3' } satisfies HomeAction);
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.create).toHaveBeenCalledTimes(2);
    expect(t.openSession).not.toHaveBeenCalled();
  });
});

describe('myWordsActions makeNext and skip', () => {
  it('a failed create is recorded, a landed one clears it', async () => {
    const t = build(async () => {
      throw new Error('boom');
    });
    await t.actions.makeNext();
    expect(t.setMakeFailed).toHaveBeenLastCalledWith(true);
    const ok = build();
    await ok.actions.makeNext();
    expect(ok.setMakeFailed).toHaveBeenLastCalledWith(false);
  });

  it('skip skips the session and then tells home', async () => {
    const t = build();
    t.actions.skip('s9');
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.skipSession).toHaveBeenCalledWith('s9');
    expect(t.onSkipped).toHaveBeenCalledTimes(1);
  });
});
