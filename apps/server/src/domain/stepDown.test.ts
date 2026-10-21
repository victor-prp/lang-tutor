import { describe, expect, it } from '@jest/globals';

import type { GradableAnswer, QuestionType } from '@lang-tutor/core/domain';

import { openStepDowns, produces } from './stepDown';

// Phase 68 (spec D1). A target word owes a step-down on a practised skill when its latest answer to
// a card of that skill, on the target's path, was a miss and no right answer to the skill's produce
// card came after it. Pure: the answers are hand-built.

type Answer = GradableAnswer & { glossId: string };

const typed = (glossId: string, type: QuestionType, verdict: GradableAnswer['verdict'], over: Partial<Answer> = {}): Answer => ({
  glossId,
  type,
  verdict,
  ...over,
});
const choice = (glossId: string, type: QuestionType, correct: boolean): Answer => ({ glossId, type, correct });

const open = (answers: Answer[], unanswered: { glossId: string; type: QuestionType; intro: boolean }[] = []) =>
  openStepDowns({ answers, unanswered }).map((step) => `${step.glossId}|${step.dimension}`);

describe('produces', () => {
  it("is each practised skill's card at the picker's rung", () => {
    expect(['typed_translation', 'cloze_typed', 'sentence_translation'].every((type) => produces(type as QuestionType, 'written_productive'))).toBe(true);
    expect(produces('reverse_choice', 'written_productive')).toBe(false);
    expect(produces('letter_tiles', 'written_productive')).toBe(false);
    expect(produces('dictation', 'spelling')).toBe(true);
    expect(produces('typed_translation', 'spelling')).toBe(false);
    expect(produces('say_translation', 'spoken_productive')).toBe(true);
    expect(produces('read_aloud', 'spoken_productive')).toBe(false);
  });
});

describe('openStepDowns', () => {
  it('opens a step-down on the skill a missed card serves', () => {
    expect(open([typed('domani', 'typed_translation', 'wrong')])).toEqual(['domani|written_productive']);
    expect(open([typed('soldi', 'dictation', 'wrong')])).toEqual(['soldi|spelling']);
    expect(open([typed('cattivo', 'say_translation', 'gave_up')])).toEqual(['cattivo|spoken_productive']);
    expect(open([choice('volere', 'reverse_choice', false)])).toEqual(['volere|written_productive']);
    expect(open([typed('volere', 'cloze_typed', 'wrong')])).toEqual(['volere|written_productive']);
  });

  it('opens nothing on a near miss, an alternative, a skip or an intro card', () => {
    expect(open([typed('a', 'typed_translation', 'near_miss')])).toEqual([]);
    expect(open([typed('a', 'typed_translation', 'alternative')])).toEqual([]);
    expect(open([typed('a', 'typed_translation', 'skipped')])).toEqual([]);
    expect(open([typed('a', 'letter_tiles', 'wrong', { intro: true })])).toEqual([]);
  });

  it('opens nothing on a card that serves no practised skill', () => {
    expect(open([choice('a', 'multiple_choice', false), choice('a', 'matching', false), typed('a', 'typed_meaning', 'wrong')])).toEqual([]);
  });

  it("closes on a later right answer to the skill's produce card, not to a pick card", () => {
    expect(open([typed('a', 'typed_translation', 'wrong'), typed('a', 'cloze_typed', 'exact')])).toEqual([]);
    expect(open([typed('a', 'typed_translation', 'wrong'), typed('a', 'sentence_translation', 'near_miss')])).toEqual([]);
    expect(open([typed('a', 'typed_translation', 'wrong'), choice('a', 'reverse_choice', true)])).toEqual(['a|written_productive']);
    expect(open([typed('a', 'say_translation', 'gave_up'), typed('a', 'say_translation', 'understood')])).toEqual([]);
    // Another skill's right answer leaves it open.
    expect(open([typed('a', 'typed_translation', 'wrong'), typed('a', 'dictation', 'exact')])).toEqual(['a|written_productive']);
  });

  it('opens again on a miss after it closed', () => {
    expect(open([typed('a', 'typed_translation', 'wrong'), typed('a', 'typed_translation', 'exact'), typed('a', 'cloze_typed', 'wrong')])).toEqual([
      'a|written_productive',
    ]);
  });

  it('owes one step-down per word and skill, however many misses, ordered by the latest miss', () => {
    expect(
      open([
        typed('a', 'typed_translation', 'wrong'),
        typed('b', 'typed_translation', 'wrong'),
        typed('a', 'typed_translation', 'wrong'),
        typed('b', 'dictation', 'wrong'),
      ]),
    ).toEqual(['b|written_productive', 'a|written_productive', 'b|spelling']);
  });

  it("closes on an unanswered produce card of the session in flight, credited right; an intro or pick card doesn't", () => {
    const missed = [typed('a', 'typed_translation', 'wrong')];
    expect(open(missed, [{ glossId: 'a', type: 'cloze_typed', intro: false }])).toEqual([]);
    expect(open(missed, [{ glossId: 'a', type: 'reverse_choice', intro: false }])).toEqual(['a|written_productive']);
    expect(open(missed, [{ glossId: 'a', type: 'typed_translation', intro: true }])).toEqual(['a|written_productive']);
    expect(open(missed, [{ glossId: 'b', type: 'typed_translation', intro: false }])).toEqual(['a|written_productive']);
  });
});
