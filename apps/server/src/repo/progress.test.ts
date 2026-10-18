import { describe, expect, it } from '@jest/globals';

import { decodeAnswer } from './progress';

// Phase 54 (spec D7). A seen answer is stored as a text answer with an empty text
// and no options to read a choice from.
describe('decodeAnswer, the meet card (phase 54, spec D7)', () => {
  it('reads a meet answer as a text type with its verdict, not as a choice', () => {
    expect(
      decodeAnswer({ gloss_id: 'g1', type: 'meet', options: null, selected_option_position: null, verdict: 'seen', retry_verdict: null, intro: false, helped: false }),
    ).toEqual({ glossId: 'g1', type: 'meet', verdict: 'seen' });
  });
});

// Phase 55 (spec D2, as ruled). A ladder's intro card is read with its mark, which the
// grades and the evidence read; a card outside one is read as before, without it.
describe('decodeAnswer, a ladder intro card (phase 55, spec D2, as ruled)', () => {
  const tiles = { gloss_id: 'g1', type: 'letter_tiles', options: null, selected_option_position: null, verdict: 'wrong', retry_verdict: null, helped: false };

  it('carries the mark of an intro card', () => {
    expect(decodeAnswer({ ...tiles, intro: true })).toEqual({ glossId: 'g1', type: 'letter_tiles', verdict: 'wrong', intro: true });
  });

  it('reads a card outside an intro as before', () => {
    expect(decodeAnswer({ ...tiles, intro: false })).toStrictEqual({ glossId: 'g1', type: 'letter_tiles', verdict: 'wrong' });
  });
});

// Phase 63 (spec D11). A choice is right when its option is, unless help was used.
describe('decodeAnswer, a helped choice (phase 63, spec D11)', () => {
  const options = [
    { position: 0, text: 'בית', is_correct: true },
    { position: 1, text: 'דלת', is_correct: false },
  ];
  const choice = { gloss_id: 'g1', type: 'multiple_choice', options, selected_option_position: 0, verdict: null, retry_verdict: null, intro: false };

  it('reads the right option chosen after help as wrong', () => {
    expect(decodeAnswer({ ...choice, helped: true })).toEqual({ glossId: 'g1', type: 'multiple_choice', correct: false });
  });

  it('reads the right option chosen without help as right', () => {
    expect(decodeAnswer({ ...choice, helped: false })).toEqual({ glossId: 'g1', type: 'multiple_choice', correct: true });
  });
});
