import { describe, expect, it } from '@jest/globals';
import type { AnswerVerdict } from '@lang-tutor/core/api';
import type { QuestionType } from '@lang-tutor/core/domain';

import { RETURNS_PER_DAY } from './chooseConstants';
import { dayState, type DayAnswer } from './today';

const mc = (glossId: string, sessionId: string, right: boolean): DayAnswer => ({
  glossId,
  sessionId,
  type: 'multiple_choice',
  correct: right,
});

const typed = (glossId: string, sessionId: string, verdict: AnswerVerdict, type: QuestionType = 'typed_translation'): DayAnswer => ({
  glossId,
  sessionId,
  type,
  verdict,
});

const none = new Set<string>();

describe('dayState (phase 37 D1)', () => {
  it('owes a word met today a written receptive return, opened at its first answer', () => {
    expect(dayState([mc('a', 's1', true)], new Set(['a']))).toEqual({
      steps: [{ glossId: 'a', dimension: 'written_receptive', opened: 0 }],
      done: new Set(),
    });
  });

  it('settles the return with a right answer in a later session', () => {
    const state = dayState([mc('a', 's1', true), typed('a', 's2', 'exact', 'typed_meaning')], new Set(['a']));
    expect(state).toEqual({ steps: [], done: new Set(['a']) });
  });

  it('does not settle it with an answer in the session that opened it', () => {
    const state = dayState([mc('a', 's1', true), mc('a', 's1', true)], new Set(['a']));
    expect(state.steps).toEqual([{ glossId: 'a', dimension: 'written_receptive', opened: 0 }]);
  });

  it('leaves a word met before today and answered right done, with no return', () => {
    expect(dayState([mc('a', 's1', true)], none)).toEqual({ steps: [], done: new Set(['a']) });
  });

  it('owes a return in the dimension a wrong answer graded Again', () => {
    expect(dayState([mc('a', 's1', false)], none).steps).toEqual([{ glossId: 'a', dimension: 'written_receptive', opened: 0 }]);
  });

  it('reads the settling before the miss within one answer', () => {
    // One letter wrong: written receptive and productive Good, spelling Again.
    const state = dayState([mc('a', 's1', true), typed('a', 's2', 'near_miss')], new Set(['a']));
    expect(state.steps).toEqual([{ glossId: 'a', dimension: 'spelling', opened: 1 }]);
  });

  it(`stops after ${RETURNS_PER_DAY} returns a day, still owed: the word is done`, () => {
    const answers = [
      { glossId: 'a', sessionId: 's1', type: 'reverse_choice', correct: false } as DayAnswer,
      typed('a', 's2', 'wrong'),
      typed('a', 's3', 'wrong'),
      typed('a', 's4', 'wrong'),
    ];
    expect(dayState(answers, none)).toEqual({ steps: [], done: new Set(['a']) });
    // Two returns made, still owed: it comes back.
    expect(dayState(answers.slice(0, 3), none).steps).toEqual([{ glossId: 'a', dimension: 'written_productive', opened: 2 }]);
  });

  it('moves the return to the dimension a later miss names', () => {
    // A typed translation got wrong grades written productive Again, not written receptive.
    const state = dayState([mc('a', 's1', false), typed('a', 's2', 'wrong')], none);
    expect(state.steps).toEqual([{ glossId: 'a', dimension: 'written_productive', opened: 1 }]);
  });

  it('counts a skipped or alternative answer as nothing: done, never a return', () => {
    for (const verdict of ['skipped', 'alternative'] as const) {
      expect(dayState([typed('a', 's1', verdict, 'say_translation')], none)).toEqual({ steps: [], done: new Set(['a']) });
    }
  });

  it('orders the returns by when theirs opened', () => {
    const state = dayState([mc('a', 's1', false), mc('b', 's1', false), typed('a', 's2', 'wrong')], none);
    expect(state.steps.map((step) => [step.glossId, step.opened])).toEqual([
      ['b', 1],
      ['a', 2],
    ]);
  });
});
