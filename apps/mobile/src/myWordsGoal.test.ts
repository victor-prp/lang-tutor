import { describe, expect, it } from '@jest/globals';

import { DEFAULT_GOAL, goalLabel, stepGoal } from './myWordsGoal';

describe('the My words daily goal stepper (phase 73, D1)', () => {
  it('steps by one and stops at 1 and 20', () => {
    expect(stepGoal(3, 1)).toBe(4);
    expect(stepGoal(3, -1)).toBe(2);
    expect(stepGoal(20, 1)).toBe(20);
    expect(stepGoal(1, -1)).toBe(1);
  });

  it('turning the goal on restores 3', () => {
    expect(DEFAULT_GOAL).toBe(3);
  });

  it('names the count, the number kept in one left-to-right run', () => {
    expect(goalLabel(1)).toBe('תרגול אחד');
    expect(goalLabel(3)).toBe('⁦3⁩ תרגולים');
    expect(goalLabel(20)).toBe('⁦20⁩ תרגולים');
  });
});
