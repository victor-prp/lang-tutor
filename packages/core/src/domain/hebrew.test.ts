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
  it('is NFC', () => {
    expect(normaliseHebrew('שָׁלוֹם'.normalize('NFD'))).toBe('שלום');
  });
});
