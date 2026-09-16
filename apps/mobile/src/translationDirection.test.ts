import { describe, expect, it } from '@jest/globals';

import { directionFor, oppositeOf, type DirectionPin } from './translationDirection';

const pin: DirectionPin = { form: 'duck', direction: 'he_en' };

describe('oppositeOf', () => {
  it('turns en_he into he_en', () => {
    expect(oppositeOf('en_he')).toBe('he_en');
  });

  it('turns he_en into en_he', () => {
    expect(oppositeOf('he_en')).toBe('en_he');
  });
});

describe('directionFor', () => {
  it('sends nothing when the learner has flipped nothing', () => {
    expect(directionFor('duck', undefined)).toBeUndefined();
  });

  // The bug in issue #29: the flip changed the label, and the submit that
  // followed sent no direction at all — so the server detected again and the
  // label silently reverted to what the flip had just overruled.
  it('sends the flipped direction again for the string it was flipped for', () => {
    expect(directionFor('duck', pin)).toBe('he_en');
  });

  // The request carries the trimmed string, so the pin is compared against the
  // same thing rather than against whatever the field happens to hold.
  it('still sends it when the string differs only by surrounding whitespace', () => {
    expect(directionFor('  duck ', pin)).toBe('he_en');
  });

  // A pin with no form would either be forgotten on the next submit — the bug —
  // or remembered forever, which is worse: the next word typed would be forced
  // into whatever direction the last flip happened to leave behind.
  it('goes back to detection for a different string', () => {
    expect(directionFor('ladder', pin)).toBeUndefined();
  });
});
