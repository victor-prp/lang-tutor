import { describe, expect, it } from '@jest/globals';

import { decodeAnswer } from './progress';

// Phase 54 (spec D7). A seen answer is stored as a text answer with an empty text
// and no options to read a choice from.
describe('decodeAnswer, the meet card (phase 54, spec D7)', () => {
  it('reads a meet answer as a text type with its verdict, not as a choice', () => {
    expect(
      decodeAnswer({ gloss_id: 'g1', type: 'meet', options: null, selected_option_position: null, verdict: 'seen', retry_verdict: null }),
    ).toEqual({ glossId: 'g1', type: 'meet', verdict: 'seen' });
  });
});
