import { describe, expect, it } from '@jest/globals';
import type { Question } from '@lang-tutor/core/api';

import { IDLE_ATTEMPT, attemptNotice, hasBanner, isSkip, passesUnseen } from './speaking';
import { strings } from './strings';

const READ: Question = { id: 'r', type: 'read_aloud', vocab_term_id: 'l', question: 'gatto', meaning: 'חתול' };
const SAY: Question = {
  id: 's',
  type: 'say_translation',
  vocab_term_id: 'l',
  question: 'חתול',
  part_of_speech: 'noun',
  answer: 'gatto',
  lemma: 'gatto',
  alternatives: [],
  context: null,
};

describe('attemptNotice (spec D7)', () => {
  it('says what was heard, that nothing was, or that it could not check, and nothing otherwise', () => {
    expect(attemptNotice({ phase: 'unheard', heard: 'cane' })).toEqual({ title: strings.notUnderstood, heard: 'cane' });
    expect(attemptNotice({ phase: 'unheard', heard: '' })).toEqual({ title: strings.heardNothing, heard: null });
    expect(attemptNotice({ phase: 'failed' })).toEqual({ title: strings.couldNotCheck, heard: null });
    expect(attemptNotice(IDLE_ATTEMPT)).toBeNull();
    expect(attemptNotice({ phase: 'checking' })).toBeNull();
  });
});

describe('passesUnseen (spec D8)', () => {
  it('passes an unanswered read-aloud card once speaking is off, and nothing else', () => {
    expect(passesUnseen(READ, 'chosen', false)).toBe(true);
    expect(passesUnseen(READ, 'no_mic', false)).toBe(true);
    expect(passesUnseen(READ, null, false)).toBe(false);
    expect(passesUnseen(READ, 'chosen', true)).toBe(false);
    expect(passesUnseen(SAY, 'chosen', false)).toBe(false);
    expect(passesUnseen(undefined, 'chosen', false)).toBe(false);
  });
  it('a passed last card completes the session: one pass, then nothing more', () => {
    expect(passesUnseen(READ, 'chosen', false)).toBe(true);
    expect(passesUnseen(READ, 'chosen', true)).toBe(false);
  });
});

describe('isSkip', () => {
  it('is a skip pass only', () => {
    expect(isSkip({ pass: 'skip' })).toBe(true);
    expect(isSkip({ pass: 'show_answer' })).toBe(false);
    expect(isSkip({ heard: 'gatto', verdict: 'understood' })).toBe(false);
  });
});

describe('hasBanner (phase 54 D1)', () => {
  it('a skip and a meet card tapped through show none; every other answer shows one', () => {
    expect(hasBanner({ pass: 'skip' })).toBe(false);
    expect(hasBanner({ seen: true })).toBe(false);
    expect(hasBanner({ pass: 'show_answer' })).toBe(true);
    expect(hasBanner({ option_index: 1 })).toBe(true);
    expect(hasBanner({ text: 'gatto' })).toBe(true);
    expect(hasBanner({ heard: 'gatto', verdict: 'understood' })).toBe(true);
  });
});

// Phase 55 (spec D7). The retype holds the banner back until it ends.
describe('hasBanner with a retype (phase 55 D7)', () => {
  it('shows none while the retype is open, and one once it ends', () => {
    expect(hasBanner({ text: 'gatto' }, null)).toBe(true);
    expect(hasBanner({ text: 'gatto' }, { attempt: 1, showing: true, outcome: null })).toBe(false);
    expect(hasBanner({ text: 'gatto' }, { attempt: 2, showing: false, outcome: null })).toBe(false);
    expect(hasBanner({ text: 'gatto' }, { attempt: 1, showing: false, outcome: 'right' })).toBe(true);
    expect(hasBanner({ text: 'gatto' }, { attempt: 2, showing: false, outcome: 'failed' })).toBe(true);
    expect(hasBanner({ pass: 'skip' }, { attempt: 2, showing: false, outcome: 'failed' })).toBe(false);
  });
});
