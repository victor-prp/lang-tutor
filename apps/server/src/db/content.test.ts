import { describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';

import { content } from './content';

const LONG_PROMPT_LENGTH = 15;

describe('content', () => {
  it('holds more questions than one session needs, so repeat sessions vary', () => {
    expect(content.length).toBeGreaterThan(SESSION_LENGTH);
  });

  it('gives every question and every term a unique id', () => {
    expect(new Set(content.map((e) => e.question_id)).size).toBe(content.length);
    expect(new Set(content.map((e) => e.term_id)).size).toBe(content.length);
  });

  it('gives every question exactly four distinct options', () => {
    for (const entry of content) {
      expect(entry.options).toHaveLength(4);
      expect(new Set(entry.options).size).toBe(4);
    }
  });

  it('points correct_option at a real option', () => {
    for (const entry of content) {
      expect(entry.correct_option).toBeGreaterThanOrEqual(0);
      expect(entry.correct_option).toBeLessThan(entry.options.length);
    }
  });

  it('keeps translation identical to the correct option', () => {
    for (const entry of content) {
      expect(entry.translation).toBe(entry.options[entry.correct_option]);
    }
  });

  it('includes enough long prompts to exercise text wrapping', () => {
    const long = content.filter((e) => e.prompt.length >= LONG_PROMPT_LENGTH);
    expect(long.length).toBeGreaterThanOrEqual(4);
  });

  it('marks a prompt that differs from its lemma with a non-base kind', () => {
    for (const entry of content) {
      if (entry.prompt === entry.lemma) expect(entry.prompt_kind).toBe('base');
      else expect(entry.prompt_kind).not.toBe('base');
    }
  });
});
