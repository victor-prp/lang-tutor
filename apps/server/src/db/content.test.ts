import { describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';

import { normalizeForm } from '../domain/vocabulary';
import { content, correctAnswerFor, optionsFor } from './content';
import { recorded } from './content.generated';

const LONG_PROMPT_LENGTH = 15;

describe('content', () => {
  it('holds more questions than one session needs, so repeat sessions vary', () => {
    expect(content.length).toBeGreaterThan(SESSION_LENGTH);
  });

  it('gives every question and every query a unique id', () => {
    expect(new Set(content.map((entry) => entry.question_id)).size).toBe(content.length);
    expect(new Set(content.map((entry) => entry.query)).size).toBe(content.length);
  });

  it('has a recording for every query', () => {
    for (const entry of content) {
      expect(recorded[entry.query]).toBeDefined();
    }
  });

  it('has at least one entry with at least one sense in every recording', () => {
    for (const entry of content) {
      const answer = recorded[entry.query];
      expect(answer.entries.length).toBeGreaterThanOrEqual(1);
      expect(answer.entries[0].senses.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('gives every question three distinct distractors and an in-range correct option', () => {
    for (const entry of content) {
      expect(entry.distractors).toHaveLength(3);
      expect(new Set(entry.distractors).size).toBe(3);
      expect(entry.correct_option).toBeGreaterThanOrEqual(0);
      expect(entry.correct_option).toBeLessThanOrEqual(3);
    }
  });

  it('splices the recorded translation in, so the quiz cannot drift from the dictionary', () => {
    for (const entry of content) {
      const options = optionsFor(entry);
      expect(options).toHaveLength(4);
      expect(options[entry.correct_option].text).toBe(correctAnswerFor(entry));
      expect(options.filter((option) => option.is_correct)).toHaveLength(1);
      expect(options.map((option) => option.position)).toEqual([0, 1, 2, 3]);
    }
  });

  it('keeps the spliced answer distinct from every distractor', () => {
    // The guard on re-recording: a regeneration that turns ספר into a string a
    // distractor already holds fails the build rather than shipping an
    // ambiguous quiz question.
    for (const entry of content) {
      expect(entry.distractors).not.toContain(correctAnswerFor(entry));
      expect(new Set(optionsFor(entry).map((option) => option.text)).size).toBe(4);
    }
  });

  it('authors every query already normalized, since the seed stores it verbatim', () => {
    for (const entry of content) {
      expect(normalizeForm(entry.query)).toBe(entry.query);
    }
  });

  it('keeps the entry-0 lemmas distinct, so no two questions share a headword', () => {
    // A question points at its query's entry 0, sense 0. Two queries resolving
    // to one lemma would make the second question's correct option belong to
    // the first one's term, since senses are first-writer-wins.
    const lemmas = content.map((entry) => recorded[entry.query].entries[0].lemma);
    expect(new Set(lemmas).size).toBe(content.length);
  });

  it('includes enough long prompts to exercise text wrapping', () => {
    const long = content.filter((entry) => entry.query.length >= LONG_PROMPT_LENGTH);
    expect(long.length).toBeGreaterThanOrEqual(4);
  });
});
