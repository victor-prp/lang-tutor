import { describe, expect, it } from '@jest/globals';

import {
  DEFAULT_SOUND_ALIKE_THRESHOLD,
  SOUND_ALIKE_MARKER,
  buildSoundAlikePrompt,
  orderedPair,
  parseSoundAlike,
  soundAlikeThreshold,
} from './soundAlike';

describe('buildSoundAlikePrompt (phase 50 D2)', () => {
  const prompt = buildSoundAlikePrompt('en', [
    { a: 'cell', b: 'sell' },
    { a: 'cell', b: 'i' },
  ]);

  it('carries the marker MockServer matches on, and the language', () => {
    expect(prompt.system).toContain(SOUND_ALIKE_MARKER);
    expect(prompt.system).toContain('English');
  });

  it('sends every pair under a short key, in order', () => {
    expect(JSON.parse(prompt.user)).toEqual({
      pairs: [
        { key: 'p1', a: 'cell', b: 'sell' },
        { key: 'p2', a: 'cell', b: 'i' },
      ],
    });
  });

  it('anchors the scale from 0 to 1, with homophones at 1', () => {
    expect(prompt.system).toMatch(/0 to 1/);
    expect(prompt.system).toMatch(/1: said exactly the same/);
    expect(prompt.system).toMatch(/0\.8: one sound differs/);
    expect(prompt.system).toMatch(/0: nothing in common/);
  });

  it('counts either standard accent for English only', () => {
    expect(prompt.system).toContain('General American or Received Pronunciation');
    expect(buildSoundAlikePrompt('ru', [{ a: 'кот', b: 'код' }]).system).not.toContain('General American');
    expect(buildSoundAlikePrompt('ru', [{ a: 'кот', b: 'код' }]).system).toContain('Russian');
  });

  it("gives none of the eval's pairs as an example, so the eval measures the rule", () => {
    for (const word of ['"cell"', '"two"', '"knight"', '"ship"', '"луг"', '"код"', '"hanno"', '"gatto"']) {
      expect(prompt.system).not.toContain(word);
    }
  });
});

describe('parseSoundAlike (phase 50 D2)', () => {
  const answer = (scores: unknown) => JSON.stringify({ scores });

  it('maps each score back to its pair by key, whatever the order', () => {
    expect(parseSoundAlike(answer([{ key: 'p2', score: 0.1 }, { key: 'p1', score: 1 }]), 2)).toEqual([1, 0.1]);
  });

  it('leaves a pair unscored when its key is missing, unknown, or answered twice after the first', () => {
    expect(
      parseSoundAlike(
        answer([
          { key: 'p1', score: 0.9 },
          { key: 'p1', score: 0.2 },
          { key: 'p9', score: 1 },
          { key: 'cell', score: 1 },
        ]),
        3,
      ),
    ).toEqual([0.9, null, null]);
  });

  it('drops a score outside 0 to 1', () => {
    expect(parseSoundAlike(answer([{ key: 'p1', score: 1.5 }, { key: 'p2', score: -0.1 }, { key: 'p3', score: 0 }]), 3)).toEqual([null, null, 0]);
  });

  it('reads fenced JSON', () => {
    expect(parseSoundAlike('```json\n' + answer([{ key: 'p1', score: 1 }]) + '\n```', 1)).toEqual([1]);
  });

  it('is null for no content, no JSON, or the wrong shape', () => {
    expect(parseSoundAlike('', 1)).toBeNull();
    expect(parseSoundAlike('not json', 1)).toBeNull();
    expect(parseSoundAlike(JSON.stringify({ verdict: 'fits' }), 1)).toBeNull();
  });
});

describe('orderedPair (phase 50 D3)', () => {
  it('orders a pair so (sell, cell) and (cell, sell) are one row', () => {
    expect(orderedPair({ heard: 'sell', form: 'cell' })).toEqual({ a: 'cell', b: 'sell' });
    expect(orderedPair({ heard: 'cell', form: 'sell' })).toEqual({ a: 'cell', b: 'sell' });
  });
});

describe('soundAlikeThreshold (phase 50 D4)', () => {
  it('defaults to 0.95', () => {
    expect(DEFAULT_SOUND_ALIKE_THRESHOLD).toBe(0.95);
    expect(soundAlikeThreshold(undefined)).toBe(0.95);
  });

  it('takes a number in (0, 1]', () => {
    expect(soundAlikeThreshold('0.9')).toBe(0.9);
    expect(soundAlikeThreshold(' 1 ')).toBe(1);
  });

  it('falls back on anything else', () => {
    for (const value of ['', '0', '-0.5', '1.5', 'abc']) expect(soundAlikeThreshold(value)).toBe(0.95);
  });
});
