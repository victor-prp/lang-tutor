import { describe, expect, it } from '@jest/globals';

import { createAppUpdates, createUpdateRequiredEvents, type UpdatesEngine } from './appUpdates';

const MIN = 60_000;

// A recording engine and a hand-moved clock: what the module asked for, in order.
function setup({ enabled = true, available = true, checkFails = false } = {}) {
  const calls: string[] = [];
  let clock = 0;
  const engine: UpdatesEngine = {
    isEnabled: enabled,
    check: async () => {
      calls.push('check');
      if (checkFails) throw new Error('offline');
      return available;
    },
    fetch: async () => {
      calls.push('fetch');
    },
    reload: async () => {
      calls.push('reload');
    },
  };
  const updates = createAppUpdates({ engine, now: () => clock, minBackgroundMs: 30 * MIN });
  const away = async (minutes: number) => {
    await updates.onAppStateChange('background');
    clock += minutes * MIN;
    await updates.onAppStateChange('active');
  };
  return { calls, updates, away };
}

describe('updates on returning to the app (phase 32, spec D8)', () => {
  it('does not check after a short absence', async () => {
    const { calls, away } = setup();
    await away(10);
    expect(calls).toEqual([]);
  });

  it('checks, fetches and reloads after 30 minutes or more away', async () => {
    const { calls, away } = setup();
    await away(31);
    expect(calls).toEqual(['check', 'fetch', 'reload']);
  });

  it('does not fetch when the check finds nothing', async () => {
    const { calls, away } = setup({ available: false });
    await away(31);
    expect(calls).toEqual(['check']);
  });

  it('does nothing when updates are disabled, as in Expo Go and on web', async () => {
    const { calls, away } = setup({ enabled: false });
    await away(120);
    expect(calls).toEqual([]);
  });

  it('swallows a failed check: no network is not an error the learner sees', async () => {
    const { calls, away } = setup({ checkFails: true });
    await expect(away(31)).resolves.toBeUndefined();
    expect(calls).toEqual(['check']);
  });

  it('checks once for one long absence, not again on each quick return after it', async () => {
    const { calls, away } = setup({ available: false });
    await away(31);
    await away(1);
    await away(2);
    expect(calls).toEqual(['check']);
  });

  it('measures from the first background, ignoring a repeated background event', async () => {
    const { calls, updates } = setup({ available: false });
    await updates.onAppStateChange('background');
    await updates.onAppStateChange('background');
    await updates.onAppStateChange('active');
    expect(calls).toEqual([]);
  });

  it('never checks on a start without a background before it', async () => {
    const { calls, updates } = setup();
    await updates.onAppStateChange('active');
    expect(calls).toEqual([]);
  });
});

describe('tryOverTheAir, the update-required screen\'s first step', () => {
  it('fetches and reloads when an update is available', async () => {
    const { calls, updates } = setup();
    expect(await updates.tryOverTheAir()).toBe(true);
    expect(calls).toEqual(['check', 'fetch', 'reload']);
  });

  it('answers false when nothing is available, so the screen offers the store', async () => {
    const { updates } = setup({ available: false });
    expect(await updates.tryOverTheAir()).toBe(false);
  });

  it('answers false when updates are disabled or the check fails', async () => {
    expect(await setup({ enabled: false }).updates.tryOverTheAir()).toBe(false);
    expect(await setup({ checkFails: true }).updates.tryOverTheAir()).toBe(false);
  });
});

describe('the update-required signal', () => {
  it('tells every listener, and a listener that unsubscribed no longer hears it', () => {
    const events = createUpdateRequiredEvents();
    const heard: string[] = [];
    const stopA = events.onUpdateRequired(() => heard.push('a'));
    events.onUpdateRequired(() => heard.push('b'));
    events.updateRequired();
    stopA();
    events.updateRequired();
    expect(heard).toEqual(['a', 'b', 'b']);
  });
});
