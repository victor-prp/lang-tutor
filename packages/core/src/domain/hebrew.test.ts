import { describe, expect, it } from '@jest/globals';

import { normaliseHebrew } from './hebrew';

describe('normaliseHebrew (phase 27 D3)', () => {
  it('removes points and cantillation', () => {
    expect(normaliseHebrew('לְדַבֵּר')).toBe('לדבר');
  });
  it('reads a maqaf as a space and drops punctuation', () => {
    expect(normaliseHebrew('בית־ספר.')).toBe('בית ספר');
    expect(normaliseHebrew('  "לדבר",  ')).toBe('לדבר');
  });
  it('keeps letters, including final forms, and collapses spaces', () => {
    expect(normaliseHebrew('ספר   טוב')).toBe('ספר טוב');
    expect(normaliseHebrew('מלך')).toBe('מלך');
  });
  it('removes invisible format marks', () => {
    expect(normaliseHebrew('להזמין\u200F')).toBe('להזמין');
    expect(normaliseHebrew('לה\u200Cזמין')).toBe('להזמין');
    expect(normaliseHebrew('\u200Eלהזמין\u200D')).toBe('להזמין');
  });
  it('composes first, so a presentation form reads as its letter', () => {
    // U+FB2A (shin with shin dot) decomposes under NFC to U+05E9 U+05C1; the dot is then stripped.
    expect('\uFB2A'.normalize('NFC')).not.toBe('\uFB2A');
    expect(normaliseHebrew('\uFB2A')).toBe('ש');
  });
});
