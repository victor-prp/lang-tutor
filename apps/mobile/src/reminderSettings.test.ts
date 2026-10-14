import { describe, expect, it } from '@jest/globals';

import {
  HOURS,
  MAX_TARGET,
  MIN_TARGET,
  WEEK_DAYS,
  clampTarget,
  createSaver,
  hourId,
  stepTarget,
  timeOf,
  toggleDay,
  toggleHour,
} from './reminderSettings';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the chips', () => {
  it('offers Monday to Sunday as ISO weekdays and 06:00 to 23:00 as whole hours', () => {
    expect(WEEK_DAYS).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(HOURS[0]).toBe(6);
    expect(HOURS[HOURS.length - 1]).toBe(23);
    expect(HOURS).toHaveLength(18);
  });

  it('writes an hour as two digits for its test id and as HH:00 on the wire', () => {
    expect(hourId(6)).toBe('06');
    expect(hourId(23)).toBe('23');
    expect(timeOf(9)).toBe('09:00');
    expect(timeOf(20)).toBe('20:00');
  });
});

describe('toggleDay', () => {
  it('adds a day in its place and takes one away', () => {
    expect(toggleDay([1, 2, 4], 3)).toEqual([1, 2, 3, 4]);
    expect(toggleDay([1, 2, 3, 4], 3)).toEqual([1, 2, 4]);
  });

  it('keeps the list sorted and distinct whatever order it arrives in', () => {
    expect(toggleDay([7, 1, 1, 3], 5)).toEqual([1, 3, 5, 7]);
    expect(toggleDay([7, 1, 1, 3], 7)).toEqual([1, 3]);
  });

  it('may empty the list: no day is a valid schedule', () => {
    expect(toggleDay([4], 4)).toEqual([]);
    expect(toggleDay([], 4)).toEqual([4]);
  });

  it('does not change the list it was given', () => {
    const days = [1, 2];
    toggleDay(days, 3);
    expect(days).toEqual([1, 2]);
  });
});

describe('toggleHour', () => {
  it('adds an hour in its place and takes one away', () => {
    expect(toggleHour(['13:00', '20:00'], 17)).toEqual(['13:00', '17:00', '20:00']);
    expect(toggleHour(['13:00', '17:00', '20:00'], 17)).toEqual(['13:00', '20:00']);
  });

  it('sorts 09:00 before 13:00 as clock times, not as numbers', () => {
    expect(toggleHour(['13:00', '22:00'], 9)).toEqual(['09:00', '13:00', '22:00']);
    expect(toggleHour(['22:00', '13:00', '13:00'], 6)).toEqual(['06:00', '13:00', '22:00']);
  });

  it('keeps a time the screen has no chip for', () => {
    expect(toggleHour(['09:30', '13:00'], 13)).toEqual(['09:30']);
    expect(toggleHour(['09:30', '13:00'], 17)).toEqual(['09:30', '13:00', '17:00']);
  });

  it('never removes the last hour: the server wants at least one', () => {
    expect(toggleHour(['13:00'], 13)).toEqual(['13:00']);
    expect(toggleHour(['09:30'], 9)).toEqual(['09:00', '09:30']);
  });

  it('does not change the list it was given', () => {
    const times = ['13:00'];
    toggleHour(times, 9);
    expect(times).toEqual(['13:00']);
  });
});

describe('the target', () => {
  it('is clamped to 1 to 5', () => {
    expect(MIN_TARGET).toBe(1);
    expect(MAX_TARGET).toBe(5);
    expect(clampTarget(0)).toBe(1);
    expect(clampTarget(-3)).toBe(1);
    expect(clampTarget(3)).toBe(3);
    expect(clampTarget(6)).toBe(5);
    expect(clampTarget(10)).toBe(5);
  });

  it('steps by one and stops at both ends', () => {
    expect(stepTarget(1, 1)).toBe(2);
    expect(stepTarget(2, -1)).toBe(1);
    expect(stepTarget(1, -1)).toBe(1);
    expect(stepTarget(5, 1)).toBe(5);
  });

  it('brings a target another client stored above 5 back into range on the next step', () => {
    expect(stepTarget(8, -1)).toBe(5);
    expect(stepTarget(8, 1)).toBe(5);
  });
});

describe('createSaver', () => {
  // A put the test settles by hand, so it decides when each save is "on the wire".
  function setup(opts: { failOn?: (value: number) => boolean } = {}) {
    const sent: number[] = [];
    const saved: number[] = [];
    const failed: unknown[] = [];
    const releases: (() => void)[] = [];
    const saver = createSaver<number>(
      (value) =>
        new Promise((resolve, reject) => {
          sent.push(value);
          releases.push(() => (opts.failOn?.(value) ? reject(new Error(`no ${value}`)) : resolve(value * 10)));
        }),
      { onSaved: (value) => saved.push(value), onFailed: (error) => failed.push(error) },
    );
    const settle = async () => {
      releases.shift()?.();
      await flush();
    };
    return { saver, sent, saved, failed, settle };
  }

  it('sends a change at once and reports the answer', async () => {
    const t = setup();
    t.saver.save(1);
    expect(t.sent).toEqual([1]);
    await t.settle();
    expect(t.saved).toEqual([10]);
  });

  it('sends one request at a time and only the newest change after a busy one', async () => {
    const t = setup();
    t.saver.save(1);
    t.saver.save(2);
    t.saver.save(3);
    expect(t.sent).toEqual([1]);
    await t.settle();
    expect(t.sent).toEqual([1, 3]);
    // The answer to 1 is not shown: 3 is already on screen and on its way.
    expect(t.saved).toEqual([]);
    await t.settle();
    expect(t.saved).toEqual([30]);
  });

  it('can save again once idle', async () => {
    const t = setup();
    t.saver.save(1);
    await t.settle();
    t.saver.save(2);
    expect(t.sent).toEqual([1, 2]);
    await t.settle();
    expect(t.saved).toEqual([10, 20]);
  });

  it('reports a failure once, when nothing newer is waiting', async () => {
    const t = setup({ failOn: (value) => value === 1 });
    t.saver.save(1);
    await t.settle();
    expect(t.failed).toHaveLength(1);
    expect(t.saved).toEqual([]);
    t.saver.save(2);
    await t.settle();
    expect(t.saved).toEqual([20]);
  });

  it('sends the newer change after a failed one, which carries the failed one with it', async () => {
    const t = setup({ failOn: (value) => value === 1 });
    t.saver.save(1);
    t.saver.save(2);
    await t.settle();
    expect(t.sent).toEqual([1, 2]);
    expect(t.failed).toEqual([]);
    await t.settle();
    expect(t.saved).toEqual([20]);
  });
});
