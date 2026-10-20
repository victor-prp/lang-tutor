import { describe, expect, it } from '@jest/globals';

import { correctedRuns, inputTone, sentenceFeedback, sentenceLine } from './explain';
import type { Feedback } from './feedback';
import { strings } from './strings';

const mistake = { wrong: 'il tavola', right: 'un tavolo', why: 'tavolo הוא זכר' };

describe("sentenceLine (phase 66b D2): what the banner's second line says", () => {
  it('says the sentence needs fixing when the check found a mistake', () => {
    expect(sentenceLine({ corrected: 'Voglio un tavolo.', mistakes: [mistake] })).toBe('fix');
  });
  it('says the sentence is right when it found none', () => {
    expect(sentenceLine({ corrected: 'Voglio un tavolo.', mistakes: [] })).toBe('right');
  });
  it('is no line when the sentence was not checked, or the check failed', () => {
    expect(sentenceLine(null)).toBeNull();
    expect(sentenceLine(undefined)).toBeNull();
  });
});

describe("inputTone (phase 66b D2): the learner's sentence's border", () => {
  it('is red for a wrong word, whatever the sentence', () => {
    expect(inputTone('wrong', 'fix')).toBe('wrong');
    expect(inputTone('wrong', null)).toBe('wrong');
  });
  it('is orange for a sentence to fix around a word that is not wrong', () => {
    expect(inputTone('exact', 'fix')).toBe('fix');
    expect(inputTone('near_miss', 'fix')).toBe('fix');
    expect(inputTone('alternative', 'fix')).toBe('fix');
    // A helped answer, or another word again: no verdict, still a sentence to fix.
    expect(inputTone(null, 'fix')).toBe('fix');
  });
  it("is otherwise the word's, as before", () => {
    expect(inputTone('exact', 'right')).toBe('correct');
    expect(inputTone('exact', null)).toBe('correct');
    expect(inputTone(null, 'right')).toBe('idle');
    expect(inputTone(null, null)).toBe('idle');
  });
});

describe('correctedRuns (phase 66b D2): the corrected sentence, its changed words marked', () => {
  const changed = (text: string, corrected: string) =>
    correctedRuns(text, corrected)
      .filter((run) => run.changed)
      .map((run) => run.text);

  it("marks the words that are not the learner's own", () => {
    expect(changed('Io vuole prenotare un camera per tre persone', 'Io voglio prenotare una camera per tre persone')).toEqual(['voglio', 'una']);
  });
  it('marks a word added, and nothing for a word taken away', () => {
    expect(changed('Voglio prenotare tavolo', 'Voglio prenotare un tavolo')).toEqual(['un']);
    expect(changed('Voglio prenotare un il tavolo', 'Voglio prenotare un tavolo')).toEqual([]);
  });
  it('joins neighbouring changed words into one run', () => {
    expect(changed('Io volere prenotare il tavola per due', 'Io voglio prenotare un tavolo per due')).toEqual(['voglio', 'un tavolo']);
  });
  it('ignores case and a full stop, which the corrected sentence may add', () => {
    expect(changed('io voglio un tavolo', 'Io voglio un tavolo.')).toEqual([]);
  });
  it('keeps every character of the corrected sentence, in order', () => {
    const corrected = 'Io  voglio prenotare una camera.';
    expect(
      correctedRuns('io vuole prenotare un camera', corrected)
        .map((run) => run.text)
        .join(''),
    ).toBe(corrected);
  });
});

describe('sentenceFeedback (phase 66b D2): the word line beside a sentence line', () => {
  const exact: Feedback = { tone: 'correct', title: strings.feedbackCorrect, line: null, verdict: 'exact' };

  it('names the word when the sentence has a line of its own', () => {
    expect(sentenceFeedback(exact, 'fix')).toEqual({ ...exact, title: strings.feedbackWordCorrect });
    expect(sentenceFeedback(exact, 'right').title).toBe(strings.feedbackWordCorrect);
  });
  it("leaves today's banner with no sentence line", () => {
    expect(sentenceFeedback(exact, null)).toBe(exact);
  });
  it('leaves every other title as it is', () => {
    const wrong: Feedback = { tone: 'wrong', title: strings.feedbackWrong, line: 'prenotare', verdict: 'wrong' };
    const nearMiss: Feedback = { tone: 'correct', title: strings.feedbackNearMiss, line: 'prenotare', verdict: 'near_miss' };
    const helped: Feedback = { tone: 'other', title: strings.feedbackHelped, line: null, verdict: null };
    for (const feedback of [wrong, nearMiss, helped]) expect(sentenceFeedback(feedback, 'fix')).toBe(feedback);
  });
});
