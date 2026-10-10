import { describe, expect, it } from '@jest/globals';

import { normaliseGloss } from './gloss';

describe('normaliseGloss', () => {
  it.each([
    ['vowelled Hebrew', 'סֵפֶר', 'ספר'],
    ['cantillation and points', 'בְּרֵאשִׁ֖ית', 'בראשית'],
    ['a stressed Russian word', 'молоко́', 'молоко'],
    ['a parenthetical', 'בסיס (צבאי)', 'בסיס'],
    ['double spaces', 'בית   קפה', 'בית קפה'],
    ['mixed case', 'Città', 'città'],
    ['Cyrillic capitals', 'ДОМ', 'дом'],
    ['a maqaf', 'בית־ספר', 'בית ספר'],
    ['a hyphen', 'בית-ספר', 'בית ספר'],
    ['surrounding spaces', '  עכבר ', 'עכבר'],
    ['a decomposed Latin accent, which NFC composes and keeps', 'café', 'café'],
  ])('%s', (_, input, expected) => {
    expect(normaliseGloss(input)).toBe(expected);
  });

  it('makes two spellings of one word one key', () => {
    expect(normaliseGloss('עַכְבָּר')).toBe(normaliseGloss('עכבר'));
  });
});
