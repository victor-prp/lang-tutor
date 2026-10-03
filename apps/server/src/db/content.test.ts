import { describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';

import { normalizeForm } from '../domain/dictionary';
import { isInScript } from '../domain/languages';
import { content, correctAnswerFor, optionsFor, parseRecordArgs, recordingKey } from './content';
import { recorded } from './content.generated';

const LONG_PROMPT_LENGTH = 15;

describe('content', () => {
  it('holds more questions than one session needs, so repeat sessions vary', () => {
    expect(content.length).toBeGreaterThan(SESSION_LENGTH);
  });

  it('gives every question and every query a unique id', () => {
    expect(new Set(content.map((entry) => entry.question_id)).size).toBe(content.length);
    expect(new Set(content.map((entry) => recordingKey(entry))).size).toBe(content.length);
  });

  it('has a recording for every query', () => {
    for (const entry of content) {
      expect(recorded[recordingKey(entry)]).toBeDefined();
    }
  });

  it('has at least one entry with at least one sense in every recording', () => {
    for (const entry of content) {
      const answer = recorded[recordingKey(entry)];
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
    const lemmas = content.map((entry) => recorded[recordingKey(entry)].entries[0].lemma);
    expect(new Set(lemmas).size).toBe(content.length);
  });

  it('includes enough long prompts to exercise text wrapping', () => {
    // Three of the six queries that used to clear LONG_PROMPT_LENGTH were the
    // sentences dropped from the seed (a real lookup never persists a
    // sentence, so seeding one would be indistinguishable from a row no
    // lookup could have produced) — the remaining thirteen queries clear it
    // with exactly three.
    const long = content.filter((entry) => entry.query.length >= LONG_PROMPT_LENGTH);
    expect(long.length).toBeGreaterThanOrEqual(3);
  });
});

describe('the pair-aware seed', () => {
  it('records every entry under its own pair', () => {
    for (const entry of content) {
      expect(recorded[recordingKey(entry)]).toBeDefined();
    }
  });

  it('seeds at least a full session for every pair it seeds at all', () => {
    const counts = new Map<string, number>();
    for (const entry of content) {
      const pair = `${entry.from}-${entry.to}`;
      counts.set(pair, (counts.get(pair) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual(['en-he', 'ru-he']);
    for (const count of counts.values()) expect(count).toBeGreaterThanOrEqual(SESSION_LENGTH);
  });

  it('never offers the correct answer as a distractor', () => {
    for (const entry of content) {
      expect(entry.distractors).not.toContain(correctAnswerFor(entry));
    }
  });

  it('writes every query in from’s script and every option in to’s', () => {
    for (const entry of content) {
      expect(isInScript(entry.query, entry.from)).toBe(true);
      for (const option of [...entry.distractors, correctAnswerFor(entry)]) {
        expect(isInScript(option, entry.to)).toBe(true);
      }
    }
  });
});

describe('parseRecordArgs', () => {
  it('reads a bare query as the filter', () => {
    expect(parseRecordArgs(['окно'])).toEqual({ filter: 'окно', pair: undefined });
  });

  it('reads a query and a pair in either order', () => {
    expect(parseRecordArgs(['--pair', 'ru-he', 'окно'])).toEqual({ filter: 'окно', pair: 'ru-he' });
    expect(parseRecordArgs(['окно', '--pair', 'ru-he'])).toEqual({ filter: 'окно', pair: 'ru-he' });
  });

  it('reads a pair alone as no filter', () => {
    expect(parseRecordArgs(['--pair', 'ru-he'])).toEqual({ filter: undefined, pair: 'ru-he' });
  });

  it('reads nothing as re-record everything', () => {
    expect(parseRecordArgs([])).toEqual({ filter: undefined, pair: undefined });
  });

  it('refuses --pair with no value', () => {
    expect(() => parseRecordArgs(['окно', '--pair'])).toThrow('--pair needs a value');
    expect(() => parseRecordArgs(['--pair', '--other'])).toThrow('--pair needs a value');
  });
});
