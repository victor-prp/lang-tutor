import { describe, expect, it } from '@jest/globals';
import type { Enrollment } from '@lang-tutor/core/api';

import { asLanguageCode, availableTargets, chooseActive, flipped, lookupDirection } from './enrollments';

const enrollment = (id: string, target: string, source = 'he'): Enrollment => ({
  id,
  user_id: 'u',
  source_language: source,
  target_language: target,
  created_at: '2026-10-03T00:00:00.000Z',
});

// The server lists newest first.
const ru = enrollment('e-ru', 'ru');
const en = enrollment('e-en', 'en');
const italian = enrollment('e-it', 'it');

describe('chooseActive', () => {
  it('takes the remembered enrollment when it is still held', () => {
    expect(chooseActive([ru, en], 'e-en')).toBe(en);
  });

  it('falls back to the newest when the remembered one is gone', () => {
    expect(chooseActive([ru, en], 'e-deleted-elsewhere')).toBe(ru);
  });

  it('falls back to the newest when nothing is remembered', () => {
    expect(chooseActive([ru, en], null)).toBe(ru);
  });

  it('is null with no enrollments, which routes to the enroll screen', () => {
    expect(chooseActive([], 'e-en')).toBeNull();
  });
});

describe('availableTargets', () => {
  it('offers every enrollable target not yet taken', () => {
    expect(availableTargets([])).toEqual(['en', 'ru', 'it']);
    expect(availableTargets([ru])).toEqual(['en', 'it']);
    expect(availableTargets([ru, en])).toEqual(['it']);
    expect(availableTargets([italian, ru, en])).toEqual([]);
  });

  it('ignores a legacy target outside the enrollable set', () => {
    expect(availableTargets([enrollment('e-he', 'he', 'en')])).toEqual(['en', 'ru', 'it']);
  });
});

describe('lookupDirection', () => {
  it('opens on target → source', () => {
    expect(lookupDirection(ru)).toEqual({ from: 'ru', to: 'he' });
    expect(flipped(lookupDirection(ru))).toEqual({ from: 'he', to: 'ru' });
  });

  it('opens an Italian enrollment on it → he', () => {
    expect(lookupDirection(italian)).toEqual({ from: 'it', to: 'he' });
  });
});

describe('asLanguageCode', () => {
  it('narrows a known code and refuses an unknown one', () => {
    expect(asLanguageCode('ru')).toBe('ru');
    expect(asLanguageCode('it')).toBe('it');
    expect(() => asLanguageCode('fr')).toThrow();
  });
});
