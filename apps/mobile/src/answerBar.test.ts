import { describe, expect, it } from '@jest/globals';

import { barButton, barNote } from './answerBar';

describe('barNote (answer bar, spec D2)', () => {
  const none = { refused: null, failed: false, checking: false, retypeAttempt: null };

  it('says nothing on a card being typed', () => {
    expect(barNote(none)).toBeNull();
  });
  it('puts a refusal first, over a failed check and a retype', () => {
    expect(barNote({ refused: 'wrong_script', failed: true, checking: false, retypeAttempt: 1 })).toBe('wrong_script');
    expect(barNote({ refused: 'word_only', failed: true, checking: false, retypeAttempt: null })).toBe('word_only');
  });
  it('says the check failed only once nothing is being checked', () => {
    expect(barNote({ ...none, failed: true })).toBe('failed');
    expect(barNote({ ...none, failed: true, checking: true })).toBeNull();
  });
  it('asks for the word again during a retype, even after a failed check', () => {
    expect(barNote({ ...none, retypeAttempt: 1 })).toBe('retype');
    expect(barNote({ ...none, failed: true, retypeAttempt: 1 })).toBe('retype');
    expect(barNote({ ...none, retypeAttempt: 2 })).toBe('retype_again');
  });
});

describe('barButton (answer bar, spec D2)', () => {
  const typing = { empty: false, checking: false, failed: false, retyping: false };

  it('checks what is typed, and waits for something to check', () => {
    expect(barButton(typing)).toEqual({ label: 'check', testID: 'typed-submit', disabled: false });
    expect(barButton({ ...typing, empty: true })).toEqual({ label: 'check', testID: 'typed-submit', disabled: true });
  });
  it('is locked while a judged answer is out', () => {
    expect(barButton({ ...typing, checking: true })).toEqual({ label: 'checking', testID: 'typed-submit', disabled: true });
    expect(barButton({ ...typing, checking: true, failed: true })).toEqual({ label: 'checking', testID: 'typed-submit', disabled: true });
  });
  it('becomes try again once the check failed, sending what is in the box', () => {
    expect(barButton({ ...typing, failed: true })).toEqual({ label: 'try_again', testID: 'judge-try-again', disabled: false });
    expect(barButton({ ...typing, failed: true, empty: true })).toEqual({ label: 'try_again', testID: 'judge-try-again', disabled: true });
  });
  it('checks a retype as any answer', () => {
    expect(barButton({ ...typing, failed: true, retyping: true })).toEqual({ label: 'check', testID: 'typed-submit', disabled: false });
  });
});
