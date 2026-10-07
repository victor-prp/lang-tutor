import { describe, expect, it } from '@jest/globals';

import { findGap } from './cloze';

describe('findGap (spec D7, phase 24 D8)', () => {
  it('finds a word as a whole word, any case', () => {
    expect(findGap('Vorrei prenotare un tavolo.', ['prenotare'])).toEqual({ start: 7, end: 16 });
    expect(findGap('Prenotare è facile.', ['prenotare'])).toEqual({ start: 0, end: 9 });
  });
  it('takes the first candidate that occurs exactly once', () => {
    expect(findGap('I booked a table.', ['book', 'booked'])).toEqual({ start: 2, end: 8 });
  });
  it('never matches inside a word', () => {
    expect(findGap('The gattone sleeps.', ['gatto'])).toBeNull();
  });
  it('matches a multi-word form as a sequence, across any spacing', () => {
    expect(findGap('Per  favore, aiutami.', ['per favore'])).toEqual({ start: 0, end: 11 });
  });
  it('reads Cyrillic letters as letters', () => {
    expect(findGap('Я ем ложкой суп.', ['ложкой'])).toEqual({ start: 5, end: 11 });
    expect(findGap('Я ем ложкой суп.', ['ложка'])).toBeNull();
  });
  it('is null for no occurrence or two', () => {
    expect(findGap('Il cane e il cane.', ['cane'])).toBeNull();
    expect(findGap('', ['cane'])).toBeNull();
  });
});
