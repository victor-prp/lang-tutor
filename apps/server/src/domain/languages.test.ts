import { describe, expect, it } from '@jest/globals';

import { LANGUAGES, guardScript, isInScript, stripStress } from './languages';

describe('guardScript', () => {
  it('passes input with no letters at all', () => {
    expect(guardScript('100%', 'ru', 'he')).toBe('pass');
    expect(guardScript('9/11', 'en', 'he')).toBe('pass');
  });

  it("passes input whose letters are in from's script", () => {
    expect(guardScript('окно', 'ru', 'he')).toBe('pass');
    expect(guardScript('ОКНО', 'ru', 'he')).toBe('pass');
    expect(guardScript('window', 'en', 'he')).toBe('pass');
    expect(guardScript('חלון', 'he', 'ru')).toBe('pass');
  });

  it("passes mixed input as long as one letter is in from's script", () => {
    expect(guardScript('ה-NBA', 'he', 'en')).toBe('pass');
  });

  it('passes Hebrew with nikud: points are marks, not letters', () => {
    expect(guardScript('סֵפֶר', 'he', 'ru')).toBe('pass');
  });

  it("calls input wholly in to's script a wrong direction", () => {
    expect(guardScript('חלון', 'ru', 'he')).toBe('wrong_direction');
    expect(guardScript('окно', 'he', 'ru')).toBe('wrong_direction');
    expect(guardScript('window', 'he', 'en')).toBe('wrong_direction');
  });

  it('reads Italian as Latin script, accents included', () => {
    expect(guardScript('perché', 'it', 'he')).toBe('pass');
    expect(guardScript('città', 'it', 'he')).toBe('pass');
    // One accented letter alone is still one Latin letter.
    expect(guardScript('è', 'it', 'he')).toBe('pass');
    expect(guardScript('חלון', 'it', 'he')).toBe('wrong_direction');
    expect(guardScript('finestra', 'he', 'it')).toBe('wrong_direction');
    expect(guardScript('окно', 'it', 'he')).toBe('out_of_pair');
  });

  it('cannot tell English from Italian, and leaves that to the model (spec D2)', () => {
    expect(guardScript('window', 'it', 'he')).toBe('pass');
  });

  it('calls any other script out of pair', () => {
    expect(guardScript('window', 'ru', 'he')).toBe('out_of_pair');
    expect(guardScript('окно', 'en', 'he')).toBe('out_of_pair');
    expect(guardScript('窓', 'ru', 'he')).toBe('out_of_pair');
  });
});

describe('isInScript', () => {
  it('is true when every letter belongs to the script', () => {
    expect(isInScript('ёлка', 'ru')).toBe(true);
    expect(isInScript('קיפוד', 'he')).toBe(true);
    expect(isInScript('café', 'en')).toBe(true);
  });

  it('is false when any letter does not', () => {
    expect(isInScript('окно window', 'ru')).toBe(false);
    expect(isInScript('ספר book', 'he')).toBe(false);
  });

  it('is true for input with no letters', () => {
    expect(isInScript('100%', 'he')).toBe(true);
  });
});

describe('stripStress', () => {
  it('removes a combining acute after a Cyrillic letter', () => {
    expect(stripStress('молоко́')).toBe('молоко');
    expect(stripStress('Молоко́')).toBe('Молоко');
    expect(stripStress('доро́га до́ма')).toBe('дорога дома');
  });

  it('keeps ё, which is a letter and not a stress mark', () => {
    expect(stripStress('ёлка')).toBe('ёлка');
    expect(stripStress('Ёлка')).toBe('Ёлка');
  });

  it('leaves a Latin accent and Hebrew points alone', () => {
    // "cafe" + U+0301, decomposed on purpose: only Cyrillic stress is stripped.
    expect(stripStress('café')).toBe('café');
    expect(stripStress('סֵפֶר')).toBe('סֵפֶר');
  });
});

describe('LANGUAGES', () => {
  it('names every language the wire knows', () => {
    expect(Object.keys(LANGUAGES).sort()).toEqual(['en', 'he', 'it', 'ru']);
  });

  // The MockServer constraint in Global Constraints, as a test: an unquoted
  // matchText matches the whole request body, and these rules are in it.
  it('carries no rule text containing a registered unquoted matchText', () => {
    const text = Object.values(LANGUAGES)
      .flatMap((language) => [...language.asSource('X'), ...language.asTarget, ...language.writing])
      .join(' ');
    expect(text).not.toMatch(/see|saw/);
  });
});
