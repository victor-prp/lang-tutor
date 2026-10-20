import type { AnswerVerdict, ExplainResponse } from '@lang-tutor/core/api';
import { normaliseTyped } from '@lang-tutor/core/domain';

import type { Feedback } from '@/feedback';
import { strings } from '@/strings';

/**
 * Phase 66b (spec D2). What a translation card shows of its sentence's check,
 * which comes with the word's grade and grades nothing: a second banner line,
 * the input's border, and the corrected sentence under it.
 */

/** The banner's second line: the sentence right, or needing a fix. Null: no
 *  line, when the sentence was not checked or the check failed. */
export type SentenceLine = 'right' | 'fix';

export function sentenceLine(explanation: ExplainResponse | null | undefined): SentenceLine | null {
  if (!explanation) return null;
  return explanation.mistakes.length === 0 ? 'right' : 'fix';
}

/** The border of the learner's sentence. A wrong word stays red; around any
 *  other, a sentence to fix is orange; otherwise the word's, as before. */
export type InputTone = 'idle' | 'correct' | 'wrong' | 'fix';

export function inputTone(verdict: AnswerVerdict | null, line: SentenceLine | null): InputTone {
  if (verdict === 'wrong') return 'wrong';
  if (line === 'fix') return 'fix';
  return verdict === null ? 'idle' : 'correct';
}

/** One stretch of the corrected sentence: words the learner wrote, or not. */
export type CorrectedRun = { text: string; changed: boolean };

/**
 * The corrected sentence in runs, its words that are not the learner's marked.
 * The learner's words are matched to it in order (their longest common
 * subsequence), each compared as `normaliseTyped` compares, so case and a full
 * stop added are no change. A word taken away leaves nothing to mark.
 */
export function correctedRuns(text: string, corrected: string): CorrectedRun[] {
  const parts = corrected.split(/(\s+)/u).filter((part) => part !== '');
  const words = parts.filter((part) => !/^\s+$/u.test(part));
  const theirs = text.split(/\s+/u).filter((word) => word !== '').map(normaliseTyped);
  const ours = words.map(normaliseTyped);
  // lengths[i][j]: the longest common run of ours[i..] and theirs[j..].
  const lengths = Array.from({ length: ours.length + 1 }, () => new Array<number>(theirs.length + 1).fill(0));
  for (let i = ours.length - 1; i >= 0; i--) {
    for (let j = theirs.length - 1; j >= 0; j--) {
      lengths[i][j] = ours[i] === theirs[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const kept = new Array<boolean>(ours.length).fill(false);
  for (let i = 0, j = 0; i < ours.length && j < theirs.length; ) {
    if (ours[i] === theirs[j]) {
      kept[i] = true;
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) i++;
    else j++;
  }

  // A space between two changed words is changed too, so they read as one run.
  const changes: boolean[] = [];
  let word = 0;
  parts.forEach((part, index) => {
    if (!/^\s+$/u.test(part)) {
      changes.push(!kept[word]);
      word++;
      return;
    }
    const before = word > 0 && !kept[word - 1];
    const after = index < parts.length - 1 && word < kept.length && !kept[word];
    changes.push(before && after);
  });
  const runs: CorrectedRun[] = [];
  parts.forEach((part, index) => {
    const last = runs[runs.length - 1];
    if (last && last.changed === changes[index]) last.text += part;
    else runs.push({ text: part, changed: changes[index] });
  });
  return runs;
}

/** The banner's word line beside a sentence line: an exact word is named as
 *  the word, since the sentence now says how it went. Every other title stays. */
export function sentenceFeedback(feedback: Feedback, line: SentenceLine | null): Feedback {
  if (line === null || feedback.tone !== 'correct' || feedback.verdict !== 'exact') return feedback;
  return { ...feedback, title: strings.feedbackWordCorrect };
}
