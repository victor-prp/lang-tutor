import { describe, expect, it } from '@jest/globals';
import { LlmPhotoReadingSchema } from '@lang-tutor/core/api/schemas';

import { PHOTO_READING_MARKER, buildPhotoReadingPrompt, parsePhotoReading } from './photoReading';

const answer = (items: { text: string; hebrew: string }[]) => JSON.stringify({ items });

describe('buildPhotoReadingPrompt', () => {
  it('names the language, carries the marker MockServer matches, and asks for the reading schema', () => {
    const prompt = buildPhotoReadingPrompt('it');
    expect(prompt.system).toContain(PHOTO_READING_MARKER);
    expect(prompt.system).toContain('Italian');
    expect(prompt.system).toContain('crossed out');
    expect(prompt.system).toContain('il gatto -> gatto');
    expect(prompt.user).toBe('Language: Italian.');
    expect(prompt.schema).toBe(LlmPhotoReadingSchema);
  });
});

describe('parsePhotoReading', () => {
  it('keeps page order, and turns an empty Hebrew into null', () => {
    const reading = parsePhotoReading(
      answer([
        { text: 'gatto', hebrew: 'חתול' },
        { text: 'in bocca al lupo', hebrew: '  ' },
      ]),
    );
    expect(reading).toEqual({
      items: [
        { text: 'gatto', hebrew: 'חתול' },
        { text: 'in bocca al lupo', hebrew: null },
      ],
      mergedCount: 0,
      droppedCount: 0,
    });
  });

  it('merges the same word read twice, keeping the first one and its Hebrew', () => {
    const reading = parsePhotoReading(
      answer([
        { text: 'Gatto', hebrew: 'חתול' },
        { text: 'casa', hebrew: '' },
        { text: ' gatto ', hebrew: 'חתולה' },
      ]),
    );
    expect(reading?.items).toEqual([
      { text: 'Gatto', hebrew: 'חתול' },
      { text: 'casa', hebrew: null },
    ]);
    expect(reading?.mergedCount).toBe(1);
  });

  it('drops an empty text and one longer than a lookup takes, so neither reaches a lookup', () => {
    const reading = parsePhotoReading(
      answer([
        { text: '   ', hebrew: 'x' },
        { text: 'a'.repeat(101), hebrew: '' },
        { text: 'a'.repeat(100), hebrew: '' },
      ]),
    );
    expect(reading?.items.map((item) => item.text.length)).toEqual([100]);
    expect(reading?.droppedCount).toBe(2);
  });

  it('strips Russian stress marks and collapses spaces', () => {
    expect(parsePhotoReading(answer([{ text: 'молоко́', hebrew: 'חלב' }]))?.items).toEqual([
      { text: 'молоко', hebrew: 'חלב' },
    ]);
    expect(parsePhotoReading(answer([{ text: 'in  bocca\tal lupo', hebrew: '' }]))?.items[0].text).toBe(
      'in bocca al lupo',
    );
  });

  it('reads a fenced answer, and refuses one that is not the schema', () => {
    expect(parsePhotoReading('```json\n' + answer([{ text: 'casa', hebrew: '' }]) + '\n```')?.items).toHaveLength(1);
    expect(parsePhotoReading('not json')).toBeNull();
    expect(parsePhotoReading(JSON.stringify({ items: [{ text: 1 }] }))).toBeNull();
    expect(parsePhotoReading(JSON.stringify({ words: [] }))).toBeNull();
  });

  it('reads an empty list as an empty reading, not a failure', () => {
    expect(parsePhotoReading(answer([]))).toEqual({ items: [], mergedCount: 0, droppedCount: 0 });
  });
});
