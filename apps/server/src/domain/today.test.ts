import { describe, expect, it } from '@jest/globals';
import type { AnswerVerdict } from '@lang-tutor/core/api';
import type { QuestionType } from '@lang-tutor/core/domain';

import { RETURNS_PER_DAY } from './chooseConstants';
import { dayState, withSessionInFlight, type DayAnswer } from './today';

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

  it('lists the done words fewest answers today first, then the longest since the last', () => {
    const state = dayState([mc('a', 's1', true), mc('b', 's1', true), mc('a', 's2', true), mc('c', 's2', true)], none);
    expect([...state.done]).toEqual(['b', 'c', 'a']);
  });

  it('orders the returns by when theirs opened', () => {
    const state = dayState([mc('a', 's1', false), mc('b', 's1', false), typed('a', 's2', 'wrong')], none);
    expect(state.steps.map((step) => [step.glossId, step.opened])).toEqual([
      ['b', 1],
      ['a', 2],
    ]);
  });
});

// Phase 54 (final review). A ladder answers one word three or four times in a session;
// the day counts one return per later session the word is answered in, as it did when a
// word had one card a session.
describe('dayState, a ladder (phase 54)', () => {
  const meet = (glossId: string, sessionId: string): DayAnswer => ({ glossId, sessionId, type: 'meet', verdict: 'seen' });
  const reverse = (glossId: string, sessionId: string, right: boolean): DayAnswer => ({
    glossId,
    sessionId,
    type: 'reverse_choice',
    correct: right,
  });
  const ladder = (sessionId: string): DayAnswer[] => [
    meet('a', sessionId),
    mc('a', sessionId, false),
    reverse('a', sessionId, false),
    typed('a', sessionId, 'wrong'),
  ];

  it('counts a re-ladder session with mixed answers as one return, and reads its settling and misses in order', () => {
    // s1 owes written productive (the typed card's Again). In s2 the meet card is the
    // return; the reverse card's Hard settles it, and the typed card's Again opens another.
    const answers = [
      ...ladder('s1'),
      meet('a', 's2'),
      mc('a', 's2', true),
      reverse('a', 's2', true),
      typed('a', 's2', 'wrong'),
    ];
    expect(dayState(answers, new Set(['a']))).toEqual({
      steps: [{ glossId: 'a', dimension: 'written_productive', opened: 7 }],
      done: new Set(),
    });
  });

  it(`spends the ${RETURNS_PER_DAY} returns over three later sessions, not within one`, () => {
    const answers = [...ladder('s1'), ...ladder('s2'), ...ladder('s3'), ...ladder('s4')];
    // Two comebacks: still owed, it comes back.
    expect(dayState(answers.slice(0, 12), new Set(['a'])).steps).toEqual([
      { glossId: 'a', dimension: 'written_productive', opened: 11 },
    ]);
    // Three: the returns are spent and the word is done.
    expect(dayState(answers, new Set(['a']))).toEqual({ steps: [], done: new Set(['a']) });
  });
});

describe('withSessionInFlight (phase 43 D4)', () => {
  const step = (glossId: string, opened: number) => ({ glossId, dimension: 'written_receptive' as const, opened });

  it('takes a return the started session asks out of the returns, and makes it done', () => {
    const day = { steps: [step('a', 0), step('b', 1)], done: new Set(['c']) };
    expect(withSessionInFlight(day, ['a'], new Set(['a', 'b', 'c']))).toEqual({
      steps: [step('b', 1)],
      done: new Set(['c', 'a']),
      extraNew: 0,
    });
  });

  // A Set keeps a value where it was first added, so an in-flight gloss already
  // done today stayed at the front, and a stock picked once the whole list was
  // done asked the started session's words again.
  it("lists the session's glosses done after today's, one already done today among them", () => {
    const { done } = withSessionInFlight({ steps: [], done: new Set(['c', 'd']) }, ['e', 'd', 'f'], new Set(['c', 'd', 'e', 'f']));
    expect([...done]).toEqual(['c', 'e', 'd', 'f']);
  });

  it('counts each gloss the session meets for the first time once, as a new word today', () => {
    const { extraNew } = withSessionInFlight({ steps: [], done: new Set() }, ['n1', 'n2', 'n1', 'old'], new Set(['old']));
    expect(extraNew).toBe(2);
  });

  it('changes nothing with no session in flight', () => {
    const day = { steps: [step('a', 0)], done: new Set(['c']) };
    expect(withSessionInFlight(day, [], new Set())).toEqual({ steps: [step('a', 0)], done: new Set(['c']), extraNew: 0 });
  });
});
