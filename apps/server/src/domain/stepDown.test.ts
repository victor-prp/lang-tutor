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

const open = (answers: Answer[], unanswered: { glossId: string; type: QuestionType; intro: boolean }[] = [], asking: string[] = []) =>
  openStepDowns({ answers, unanswered, asking }).map((step) => `${step.glossId}|${step.dimension}`);

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

  it("closes on an unanswered produce card of a step-down the session in flight asks, credited right, a practice one's too; a pick card doesn't", () => {
    const missed = [typed('a', 'typed_translation', 'wrong')];
    const asking = ['a|written_productive'];
    expect(open(missed, [{ glossId: 'a', type: 'cloze_typed', intro: false }], asking)).toEqual([]);
    expect(open(missed, [{ glossId: 'a', type: 'typed_translation', intro: true }], asking)).toEqual([]);
    expect(open(missed, [{ glossId: 'a', type: 'reverse_choice', intro: true }], asking)).toEqual(['a|written_productive']);
    expect(open(missed, [{ glossId: 'b', type: 'typed_translation', intro: false }], asking)).toEqual(['a|written_productive']);
  });

  // Final review C1 (ruling 2026-10-22). The next stock is chosen when its session starts, every card
  // unanswered: a plain card on the missed skill, chosen before the miss, would close the step-down at
  // every choice, and practice more asks a word its weakest skill each session, so it never came.
  it("leaves it open beside the session in flight's own card on that skill, when that session asks no step-down there", () => {
    const missed = [typed('a', 'typed_translation', 'wrong')];
    expect(open(missed, [{ glossId: 'a', type: 'typed_translation', intro: false }])).toEqual(['a|written_productive']);
    expect(open(missed, [{ glossId: 'a', type: 'typed_translation', intro: false }], ['a|spelling'])).toEqual(['a|written_productive']);
  });

  it("closes on a practice step-down's produce card answered right, and stays open when it is missed (final review)", () => {
    const missed = [typed('a', 'typed_translation', 'wrong')];
    expect(open([...missed, typed('a', 'cloze_typed', 'exact', { intro: true })])).toEqual([]);
    expect(open([...missed, typed('a', 'cloze_typed', 'wrong', { intro: true })])).toEqual(['a|written_productive']);
    // A miss on an intro card opens nothing: a ladder's, or a step-down's pick card.
    expect(open([{ ...choice('b', 'reverse_choice', false), intro: true }])).toEqual([]);
  });
});
