import { describe, expect, it } from '@jest/globals';

import { choiceHelpDone, ruledOut } from './choiceHelp';

// Phase 63 (spec D7). Help on a choice card rules out one wrong option a press,
// never the right one, until two are left; the same options for the same card,
// with no Math.random (ADR 0002).
describe('choice help (phase 63 D7)', () => {
  const card = (id: string, correct = 1) => ({ id, options: ['a', 'b', 'c', 'd'], correct_option: correct });

  it('rules out one wrong option a press, down to two left', () => {
    expect(ruledOut(card('q1'), 0)).toEqual([]);
    expect(ruledOut(card('q1'), 1)).toHaveLength(1);
    expect(ruledOut(card('q1'), 2)).toHaveLength(2);
    expect(ruledOut(card('q1'), 3)).toHaveLength(2);
    expect(ruledOut(card('q1'), 2).slice(0, 1)).toEqual(ruledOut(card('q1'), 1));
  });

  it('never rules out the right option', () => {
    for (const correct of [0, 1, 2, 3]) {
      for (const id of ['a', 'b', 'c', 'd', 'e']) expect(ruledOut(card(id, correct), 2)).not.toContain(correct);
    }
  });

  it('rules out the same options for the same card', () => {
    expect(ruledOut(card('q7'), 2)).toEqual(ruledOut(card('q7'), 2));
  });

  it('does not always rule out the same position', () => {
    const firsts = new Set('abcdefghijklmnopqrstuvwxyz'.split('').map((id) => ruledOut(card(id), 1)[0]));
    expect(firsts.size).toBeGreaterThan(1);
  });

  it('is done once two options are left', () => {
    expect(choiceHelpDone(card('q1'), 1)).toBe(false);
    expect(choiceHelpDone(card('q1'), 2)).toBe(true);
    expect(choiceHelpDone({ id: 'q', options: ['a', 'b', 'c'], correct_option: 0 }, 1)).toBe(true);
  });
});
