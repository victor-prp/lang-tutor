import { describe, expect, it } from '@jest/globals';
import type { MatchingQuestion } from '@lang-tutor/core/api';

import { boardHelpDone, firstAttempts, helpBoard, helpedWords, startBoard, tapMeaning, tapWord } from './board';

const question = (current = 'm1'): MatchingQuestion => ({
  id: current,
  type: 'matching',
  vocab_term_id: 'v',
  question: 'casa',
  options: ['בית', 'חתול', 'כלב', 'עץ', 'דלת'],
  correct_option: 0,
  board: { question_ids: ['m1', 'm2', 'm3', 'm4'], words: ['casa', 'gatto', 'cane', 'albero'], parts_of_speech: ['noun', 'noun', 'noun', 'noun'], correct_options: [0, 1, 2, 3] },
  part_of_speech: 'noun',
});

const play = (q: MatchingQuestion, taps: (['w' | 'm', number])[]) =>
  taps.reduce((state, [kind, index]) => (kind === 'w' ? tapWord(state, q, index) : tapMeaning(state, q, index)), startBoard(q));

describe('the matching board (spec D10)', () => {
  it('locks a right pair, whichever is tapped first', () => {
    const q = question();
    expect(play(q, [['w', 0], ['m', 0]]).matched).toEqual([true, false, false, false]);
    expect(play(q, [['m', 1], ['w', 1]]).matched).toEqual([false, true, false, false]);
  });

  it('charges a wrong pair to the word, releases both, and keeps only the first try', () => {
    const q = question();
    const state = play(q, [['w', 0], ['m', 4], ['w', 0], ['m', 2], ['w', 0], ['m', 0]]);
    expect(state.first[0]).toBe(4);
    expect(state.first[2]).toBeNull();
    expect(state.matched[0]).toBe(true);
  });

  it('shows the last miss until the next tap', () => {
    const q = question();
    const missed = play(q, [['w', 0], ['m', 4]]);
    expect(missed.miss).toEqual({ word: 0, meaning: 4 });
    expect(tapWord(missed, q, 1).miss).toBeNull();
  });

  // Review Focus 5.
  it('ignores a tap on a matched word or a taken meaning, and a second tap on a word deselects', () => {
    const q = question();
    const matched = play(q, [['w', 0], ['m', 0]]);
    expect(tapWord(matched, q, 0)).toBe(matched);
    expect(tapMeaning(matched, q, 0)).toBe(matched);
    const toggled = play(q, [['w', 1], ['w', 1]]);
    expect(toggled.word).toBeNull();
    expect(toggled.first).toEqual([null, null, null, null]);
  });

  it('gives every first try once the last word is matched, and not before', () => {
    const q = question();
    const three = play(q, [['w', 0], ['m', 1], ['w', 0], ['m', 0], ['w', 1], ['m', 1], ['w', 2], ['m', 2]]);
    expect(firstAttempts(three)).toBeNull();
    expect(firstAttempts(tapMeaning(tapWord(three, q, 3), q, 3))).toEqual([1, 1, 2, 3]);
  });

  // Review Focus 1.
  it('starts a resumed board with the earlier words matched, and submits only the rest', () => {
    const q = question('m3');
    const start = startBoard(q);
    expect(start.matched).toEqual([true, true, false, false]);
    const done = play(q, [['w', 2], ['m', 2], ['w', 3], ['m', 3]]);
    expect(firstAttempts(done)).toEqual([2, 3]);
  });
});

// Phase 63 (spec D8). Help on the board matches one pair a press: the word
// selected, else the selected meaning's word, else the first unmatched word.
describe('help on the board (phase 63 D8)', () => {
  it('matches the selected word, marked helped, its first try its meaning', () => {
    const q = question();
    const state = helpBoard(play(q, [['w', 2]]), q);
    expect(state.matched).toEqual([false, false, true, false]);
    expect(state.helped).toEqual([false, false, true, false]);
    expect(state.first[2]).toBe(2);
    expect(state.word).toBeNull();
  });

  it('matches the selected meaning’s word', () => {
    const q = question();
    expect(helpBoard(play(q, [['m', 3]]), q).helped).toEqual([false, false, false, true]);
  });

  it('matches the first unmatched word when nothing is selected', () => {
    const q = question();
    expect(helpBoard(play(q, [['w', 0], ['m', 0]]), q).helped).toEqual([false, true, false, false]);
  });

  // Review focus 4: the fifth meaning belongs to no word.
  it('falls back to the first unmatched word when the distractor meaning is selected', () => {
    const q = question();
    expect(helpBoard(play(q, [['m', 4]]), q).helped).toEqual([true, false, false, false]);
  });

  it('keeps a wrong first try on the word it helps', () => {
    const q = question();
    expect(helpBoard(play(q, [['w', 1], ['m', 4], ['w', 1]]), q).first[1]).toBe(4);
  });

  // Review focus 4: a board resumed mid-way sends only the words this screen played.
  it('says which words of this screen were helped, from where it started', () => {
    const q = question('m3');
    const state = helpBoard(startBoard(q), q);
    expect(state.helped).toEqual([false, false, true, false]);
    expect(helpedWords(state)).toEqual([true, false]);
  });

  it('is done once every word is matched', () => {
    const q = question();
    const all = [0, 1, 2, 3].reduce((state) => helpBoard(state, q), startBoard(q));
    expect(boardHelpDone(all)).toBe(true);
    expect(firstAttempts(all)).toEqual([0, 1, 2, 3]);
    expect(boardHelpDone(startBoard(q))).toBe(false);
  });
});
