import { describe, expect, it } from '@jest/globals';
import type { Question } from '@lang-tutor/core/api';

import { cardVoice, nextCue, NO_CUE, type CardVoice, type CueInput, type CueState } from './cardVoice';

// Only the fields cardVoice reads; the rest of each question does not matter here.
const q = (fields: Record<string, unknown>) => fields as unknown as Question;
const sentence = 'Ieri parlavamo per ore.';

const CARDS: Record<Question['type'], Question> = {
  multiple_choice: q({ id: '1', type: 'multiple_choice', question: 'casa', options: ['בית', 'דלת'], correct_option: 0 }),
  new_meaning: q({ id: '2', type: 'new_meaning', question: 'pianta', options: ['צמח', 'מפה'], correct_option: 0 }),
  typed_meaning: q({ id: '3', type: 'typed_meaning', question: 'porta', meaning: 'דלת' }),
  listen_choice: q({ id: '4', type: 'listen_choice', question: 'casa', options: ['בית'], correct_option: 0 }),
  dictation: q({ id: '5', type: 'dictation', question: 'parlo', meaning: 'מדבר' }),
  read_aloud: q({ id: '6', type: 'read_aloud', question: 'gatto', meaning: 'חתול' }),
  meet: q({ id: '6m', type: 'meet', question: 'finestra', meaning: 'חלון' }),
  reverse_choice: q({ id: '7', type: 'reverse_choice', question: 'בית', options: ['porta', 'casa'], correct_option: 1 }),
  typed_translation: q({ id: '8', type: 'typed_translation', question: 'חלון', answer: 'finestra' }),
  letter_tiles: q({ id: '9', type: 'letter_tiles', question: 'בית', answer: 'casa', tiles: [] }),
  say_translation: q({ id: '10', type: 'say_translation', question: 'כלב', answer: 'cane' }),
  cloze_choice: q({ id: '11', type: 'cloze_choice', sentence, gap: { start: 5, end: 14 }, options: ['parlavamo', 'parlano'], correct_option: 0 }),
  cloze_typed: q({ id: '12', type: 'cloze_typed', sentence, gap: { start: 5, end: 14 }, answer: 'parlavamo' }),
  sentence_translation: q({ id: '13', type: 'sentence_translation', question: 'אתמול דיברנו', sentence, answer: 'parlavamo' }),
  matching: q({ id: '14', type: 'matching', question: 'casa', board: { words: ['casa'] }, options: ['בית'] }),
};

const voiceOf = (type: Question['type']) => cardVoice(CARDS[type], { speaking: true });

describe('cardVoice (spec D1)', () => {
  it.each([
    ['multiple_choice', { arrival: 'casa', after: null }],
    ['new_meaning', { arrival: 'pianta', after: null }],
    ['typed_meaning', { arrival: 'porta', after: null }],
    ['listen_choice', { arrival: 'casa', after: null }],
    ['dictation', { arrival: 'parlo', after: null }],
    ['read_aloud', { arrival: 'gatto', after: null }],
    ['meet', { arrival: 'finestra', after: null }],
    ['reverse_choice', { arrival: null, after: 'casa' }],
    ['typed_translation', { arrival: null, after: 'finestra' }],
    ['letter_tiles', { arrival: null, after: 'casa' }],
    ['say_translation', { arrival: null, after: 'cane' }],
    ['cloze_choice', { arrival: null, after: sentence }],
    ['cloze_typed', { arrival: null, after: sentence }],
    ['sentence_translation', { arrival: null, after: sentence }],
    ['matching', { arrival: null, after: null }],
  ] as [Question['type'], CardVoice][])('%s', (type, expected) => {
    expect(voiceOf(type)).toEqual(expected);
  });

  it('Done 1: every type but the board makes a sound (the board speaks on tap, D5)', () => {
    for (const type of Object.keys(CARDS) as Question['type'][]) {
      const { arrival, after } = voiceOf(type);
      if (type !== 'matching') expect(arrival ?? after).not.toBeNull();
    }
  });

  it('Done 2: a card whose answer is target-language text is silent on arrival, but for dictation, read aloud and meet', () => {
    const producesTarget: Question['type'][] = [
      'reverse_choice', 'typed_translation', 'letter_tiles', 'say_translation',
      'cloze_choice', 'cloze_typed', 'sentence_translation',
    ];
    for (const type of producesTarget) expect(voiceOf(type).arrival).toBeNull();
  });

  it('R7: no card has both cues', () => {
    for (const type of Object.keys(CARDS) as Question['type'][]) {
      const { arrival, after } = voiceOf(type);
      expect(arrival !== null && after !== null).toBe(false);
    }
  });

  it('a read-aloud card passed unseen, with speaking off, says nothing', () => {
    expect(cardVoice(CARDS.read_aloud, { speaking: false })).toEqual({ arrival: null, after: null });
  });

  it('a meet card says its word on arrival whether or not speaking is off (phase 54 D1)', () => {
    expect(cardVoice(CARDS.meet, { speaking: true })).toEqual({ arrival: 'finestra', after: null });
    expect(cardVoice(CARDS.meet, { speaking: false })).toEqual({ arrival: 'finestra', after: null });
  });

  it('a say-the-translation card typed, with speaking off, keeps its cue', () => {
    expect(cardVoice(CARDS.say_translation, { speaking: false })).toEqual({ arrival: null, after: 'cane' });
  });
});

describe('nextCue (spec D2)', () => {
  const word: CardVoice = { arrival: 'casa', after: null };
  const typed: CardVoice = { arrival: null, after: 'finestra' };
  const input = (over: Partial<CueInput>): CueInput => ({ id: 'a', voice: word, voiced: true, banner: false, ...over });

  // Runs the inputs in order, as the hook's effect would, and collects the cues.
  function run(inputs: CueInput[], from: CueState = NO_CUE) {
    let state = from;
    return inputs.map((next) => {
      const step = nextCue(state, next);
      state = step.state;
      return step.cue;
    });
  }

  it('a card says its arrival cue once, however often it re-renders', () => {
    expect(run([input({}), input({}), input({})])).toEqual([{ kind: 'say', text: 'casa' }, null, null]);
  });

  it('arrival waits for a voice, then plays once it is there', () => {
    expect(run([input({ voiced: false }), input({ voiced: true })])).toEqual([{ kind: 'stop' }, { kind: 'say', text: 'casa' }]);
  });

  it('voices that arrive after the answer play nothing', () => {
    expect(run([input({ voiced: false }), input({ voiced: false, banner: true }), input({ voiced: true, banner: true })])).toEqual([
      { kind: 'stop' },
      null,
      null,
    ]);
  });

  it('the after cue plays once, when the banner appears', () => {
    const cues = run([input({ voice: typed }), input({ voice: typed, banner: true }), input({ voice: typed, banner: true })]);
    expect(cues).toEqual([{ kind: 'stop' }, { kind: 'say', text: 'finestra' }, null]);
  });

  it('R6: a second-try hold shows no banner and plays nothing; the final banner plays the answer', () => {
    // Answered once (held: no banner), tried again, then the banner.
    const cues = run([input({ voice: typed }), input({ voice: typed }), input({ voice: typed, banner: true })]);
    expect(cues).toEqual([{ kind: 'stop' }, null, { kind: 'say', text: 'finestra' }]);
  });

  it('R7: a card that spoke on arrival says nothing more on the banner', () => {
    expect(run([input({}), input({ banner: true })])).toEqual([{ kind: 'say', text: 'casa' }, null]);
  });

  it('R8: a new card with nothing to say on arrival stops what is playing', () => {
    expect(run([input({ voice: typed }), input({ voice: typed, banner: true }), input({ id: 'b', voice: typed })])).toEqual([
      { kind: 'stop' },
      { kind: 'say', text: 'finestra' },
      { kind: 'stop' },
    ]);
  });

  it('a new card with an arrival cue says it (say stops the old one itself)', () => {
    expect(run([input({ voice: typed, banner: true }), input({ id: 'b' })])).toEqual([
      { kind: 'say', text: 'finestra' },
      { kind: 'say', text: 'casa' },
    ]);
  });

  it('a card with no voice in the language says nothing after the answer', () => {
    expect(run([input({ voice: typed, voiced: false }), input({ voice: typed, voiced: false, banner: true })])).toEqual([
      { kind: 'stop' },
      null,
    ]);
  });
});
