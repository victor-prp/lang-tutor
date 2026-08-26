import { describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';

import { mockQuestions } from './mockQuestions';

const LONG_PROMPT_LENGTH = 15;

describe('mockQuestions', () => {
  it('holds more questions than one session needs, so repeat sessions vary', () => {
    expect(mockQuestions.length).toBeGreaterThan(SESSION_LENGTH);
  });

  it('gives every question a unique id', () => {
    const ids = mockQuestions.map((question) => question.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every question exactly four distinct options', () => {
    for (const question of mockQuestions) {
      expect(question.options).toHaveLength(4);
      expect(new Set(question.options).size).toBe(4);
    }
  });

  it('points correct_option at a real option', () => {
    for (const question of mockQuestions) {
      expect(question.correct_option).toBeGreaterThanOrEqual(0);
      expect(question.correct_option).toBeLessThan(question.options.length);
    }
  });

  it('includes enough long prompts to exercise text wrapping', () => {
    const longPrompts = mockQuestions.filter(
      (question) => question.question.length >= LONG_PROMPT_LENGTH,
    );
    expect(longPrompts.length).toBeGreaterThanOrEqual(4);
  });
});
