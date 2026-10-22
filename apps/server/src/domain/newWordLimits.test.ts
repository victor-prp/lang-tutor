import { describe, expect, it } from '@jest/globals';

import { DAY_NEW_CAP } from './chooseConstants';
import { DEFAULT_LIMITS, limitsOf, storedDayCap } from './newWordLimits';

describe('new-word limits (phase 70, spec D1–D3)', () => {
  it('reads a learner who never chose as the defaults: the daily cap and automatic', () => {
    expect(limitsOf({ dayCap: null, perSession: null })).toEqual({ dayCap: DAY_NEW_CAP, perSession: null });
    expect(DEFAULT_LIMITS).toEqual({ dayCap: DAY_NEW_CAP, perSession: null });
  });

  it('reads what a learner chose', () => {
    expect(limitsOf({ dayCap: 30, perSession: 2 })).toEqual({ dayCap: 30, perSession: 2 });
    expect(limitsOf({ dayCap: null, perSession: 1 })).toEqual({ dayCap: DAY_NEW_CAP, perSession: 1 });
  });

  it('stores a cap equal to the default as null, so the learner keeps following the default', () => {
    expect(storedDayCap(DAY_NEW_CAP)).toBeNull();
    expect(storedDayCap(20)).toBe(20);
    expect(storedDayCap(5)).toBe(5);
  });
});
