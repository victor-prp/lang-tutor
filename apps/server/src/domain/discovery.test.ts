import { describe, expect, it } from '@jest/globals';
import type { DiscoverySelfLevel } from '@lang-tutor/core/api';

import {
  CANDIDATES,
  DISCOVERY_MARKER,
  EXCLUDE_IN_PROMPT,
  ROUND_SIZE,
  bandOf,
  buildDiscoveryPrompt,
  firstLevel,
  levelAfter,
  parseDiscovery,
  wordKey,
} from './discovery';
import { MAX_ITEM_LENGTH } from './photoReading';

const answered = (known: number, total: number) =>
  Array.from({ length: total }, (_, index) => ({ known: index < known }));

describe('firstLevel (phase 69, spec D3)', () => {
  it.each<[DiscoverySelfLevel, number]>([
    ['none', 1],
    ['basic', 2],
    ['simple', 3],
    ['everyday', 5],
    ['fluent', 7],
  ])('%s starts at %i', (self, level) => {
    expect(firstLevel(self)).toBe(level);
  });
});

describe('levelAfter (phase 69, spec D3)', () => {
  it('keeps the level when fewer than four cards were answered', () => {
    expect(levelAfter(5, answered(0, 3))).toBe(5);
    expect(levelAfter(5, answered(3, 3))).toBe(5);
  });

  it.each([
    [8, 7],
    [6, 6],
    [3, 5],
    [2, 4],
    [1, 4],
    [0, 3],
  ])('at level 5, %i known of 10 moves to %i', (known, level) => {
    expect(levelAfter(5, answered(known, 10))).toBe(level);
  });

  it('reads the share, not the count: 4 of 5 is 0.8', () => {
    expect(levelAfter(5, answered(4, 5))).toBe(7);
  });

  it('stays between 1 and 12', () => {
    expect(levelAfter(12, answered(10, 10))).toBe(12);
    expect(levelAfter(11, answered(10, 10))).toBe(12);
    expect(levelAfter(1, answered(0, 10))).toBe(1);
    expect(levelAfter(2, answered(0, 10))).toBe(1);
  });
});

describe('bandOf (phase 69, spec D3)', () => {
  it.each<[number, string, string]>([
    [1, 'A1', 'lower'],
    [2, 'A1', 'upper'],
    [3, 'A2', 'lower'],
    [6, 'B1', 'upper'],
    [7, 'B2', 'lower'],
    [10, 'C1', 'upper'],
    [12, 'C2', 'upper'],
  ])('level %i is %s, the %s half', (level, cefr, half) => {
    expect(bandOf(level)).toEqual({ cefr, half });
  });
});

describe('buildDiscoveryPrompt (phase 69, spec D4)', () => {
  const input = {
    target: 'it' as const,
    level: 6,
    age: 10,
    learningContext: 'school' as const,
    exclude: ['gatto', 'cane'],
  };

  it('names the task, the language, the count and the band', () => {
    const { system } = buildDiscoveryPrompt(input);
    expect(system).toContain(DISCOVERY_MARKER);
    expect(system).toContain('Italian');
    expect(system).toContain(String(CANDIDATES));
    expect(system).toContain('B1');
    expect(system).toContain('upper');
  });

  it('sends the learner and the words to leave out as JSON', () => {
    const user = JSON.parse(buildDiscoveryPrompt(input).user) as Record<string, unknown>;
    expect(user).toMatchObject({ language: 'Italian', level: 'B1 upper', age: 10, learning_context: 'school', exclude: ['gatto', 'cane'] });
  });

  it('sends at most 400 words to leave out, the first ones', () => {
    const exclude = Array.from({ length: 450 }, (_, index) => `w${index}`);
    const user = JSON.parse(buildDiscoveryPrompt({ ...input, exclude }).user) as { exclude: string[] };
    expect(EXCLUDE_IN_PROMPT).toBe(400);
    expect(user.exclude).toHaveLength(400);
    expect(user.exclude[0]).toBe('w0');
    expect(user.exclude[399]).toBe('w399');
  });
});

describe('wordKey (phase 69, spec D4)', () => {
  it('reads a word as the dictionary keys it, lower-cased', () => {
    expect(wordKey(' Gatto ')).toBe('gatto');
    expect(wordKey('città')).toBe(wordKey('Città'));
  });
});

describe('parseDiscovery (phase 69, spec D4)', () => {
  const word = (text: string, hebrew = 'משהו', alternatives: string[] = []) => ({
    word: text,
    part_of_speech: 'noun',
    hebrew,
    alternatives,
  });
  const raw = (words: unknown[]) => JSON.stringify({ words });

  it('keeps the words in order, each with its meanings', () => {
    const parsed = parseDiscovery(raw([word('gatto', ' חתול ', ['חתלתול', ' '])]), new Set());
    expect(parsed).toEqual({
      words: [{ word: 'gatto', partOfSpeech: 'noun', hebrew: 'חתול', alternatives: ['חתלתול'] }],
      dropped: 0,
    });
  });

  it('drops a word in Hebrew script, an empty one and an over-long one', () => {
    const parsed = parseDiscovery(raw([word('חתול'), word('  '), word('a'.repeat(MAX_ITEM_LENGTH + 1)), word('cane')]), new Set());
    expect(parsed?.words.map((kept) => kept.word)).toEqual(['cane']);
    expect(parsed?.dropped).toBe(3);
  });

  it('drops a repeated word and one to leave out, by its key', () => {
    const parsed = parseDiscovery(raw([word('gatto'), word('Gatto'), word('Cane'), word('casa')]), new Set(['cane']));
    expect(parsed?.words.map((kept) => kept.word)).toEqual(['gatto', 'casa']);
    expect(parsed?.dropped).toBe(2);
  });

  it('keeps at most a round of words', () => {
    const many = Array.from({ length: CANDIDATES }, (_, index) => word(`parola${index}`));
    expect(parseDiscovery(raw(many), new Set())?.words).toHaveLength(ROUND_SIZE);
  });

  it('drops a word with no meaning', () => {
    expect(parseDiscovery(raw([word('gatto', ' ')]), new Set())).toEqual({ words: [], dropped: 1 });
  });

  it('answers null when the answer is not the schema', () => {
    expect(parseDiscovery('not json', new Set())).toBeNull();
    expect(parseDiscovery(JSON.stringify({ items: [] }), new Set())).toBeNull();
    expect(parseDiscovery(raw([{ word: 'gatto' }]), new Set())).toBeNull();
  });
});
