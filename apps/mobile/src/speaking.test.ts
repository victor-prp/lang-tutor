import { describe, expect, it } from '@jest/globals';
import type { Question } from '@lang-tutor/core/api';

import { IDLE_ATTEMPT, attemptNotice, isSkip, passesUnseen } from './speaking';
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
