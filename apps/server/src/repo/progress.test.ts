import { describe, expect, it } from '@jest/globals';

import { decodeAnswer } from './progress';

// Phase 54 (spec D7). A seen answer is stored as a text answer with an empty text
// and no options to read a choice from.
describe('decodeAnswer, the meet card (phase 54, spec D7)', () => {
  it('reads a meet answer as a text type with its verdict, not as a choice', () => {
    expect(
      decodeAnswer({ gloss_id: 'g1', type: 'meet', options: null, selected_option_position: null, verdict: 'seen', retry_verdict: null, intro: false }),
    ).toEqual({ glossId: 'g1', type: 'meet', verdict: 'seen' });
  });
});

// Phase 55 (spec D2, as ruled). A ladder's intro card is read with its mark, which the
// grades and the evidence read; a card outside one is read as before, without it.
describe('decodeAnswer, a ladder intro card (phase 55, spec D2, as ruled)', () => {
  const tiles = { gloss_id: 'g1', type: 'letter_tiles', options: null, selected_option_position: null, verdict: 'wrong', retry_verdict: null };

  it('carries the mark of an intro card', () => {
    expect(decodeAnswer({ ...tiles, intro: true })).toEqual({ glossId: 'g1', type: 'letter_tiles', verdict: 'wrong', intro: true });
  });

  it('reads a card outside an intro as before', () => {
    expect(decodeAnswer({ ...tiles, intro: false })).toStrictEqual({ glossId: 'g1', type: 'letter_tiles', verdict: 'wrong' });
  });
});
