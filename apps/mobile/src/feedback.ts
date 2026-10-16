import type { AnswerVerdict, PendingRetry, Question } from '@lang-tutor/core/api';
import { evaluate, normaliseHebrew, normaliseTyped, rightAnswer, type AnswerInput } from '@lang-tutor/core/domain';

import type { Retype } from '@/retype';
import { strings } from '@/strings';

/** What the banner says after an answer. `tone` picks its colours; a near miss
 *  and an alternative count as correct, so they are `correct`. Phase 45: `other`
 *  is another accepted word again on a second try, neither right nor wrong. */
export type Feedback = {
  tone: 'correct' | 'wrong' | 'other';
  title: string;
  line: string | null;
  verdict: AnswerVerdict | null;
};

/** Phase 24. What a card was answered with: an option, a text, or a board's
 *  first tries (spec D10). Phase 25: a spoken answer carries the verdict the
 *  server recorded for it, so the app never judges a transcript itself. */
export type CardAnswer =
  | Exclude<AnswerInput, { heard: string }>
  | { board: number[] }
  // Phase 56 (spec D8): `helped`, said with help, which the server records given up.
  | { heard: string; verdict: 'understood' | 'alternative'; helped?: boolean };

/**
 * Phase 23. The banner after an answer. It runs the same `evaluate` the server
 * runs, so what the learner is told is what the server records (spec D9).
 *
 * Phase 34 (spec D9, ruling R16). `retry` is the hold a second try answers, and
 * null for every other answer. A second try given up leaves the card where its
 * first answer put it: right, with another accepted word. So its banner is that
 * answer's, which names the saved word, never "the right answer was".
 *
 * Phase 42 (spec D1). A wrong second try that was typed is told so, its input
 * marked wrong: the first answer's "right" banner read as if this one were
 * accepted. Given up is a blank text or a pass, since a judged card's give-up
 * comes back `wrong` (phase 34 ruling R15). Phase 45: the first answer sent again,
 * and another accepted word again, are "still not the word", neither green nor red.
 *
 * Phase 55 (spec D6, D7). The text is told by its own verdict, without `helped`:
 * the server records a helped tiles or typed answer `wrong`, and its banner is
 * "right, with help" when the text was the word or another accepted one (on a
 * second try, nearly the word too), with no line and its input not coloured; a
 * helped wrong text is a wrong one. A retype that has ended tells how it ended,
 * whatever the first answer was; one still open leaves the first answer's
 * banner, whose title the retype shows.
 */
export function feedbackFor(question: Question, answer: CardAnswer, retry: PendingRetry | null, retype: Retype | null = null): Feedback {
  if (retype?.outcome === 'right') return { tone: 'correct', title: strings.feedbackCorrect, line: null, verdict: 'exact' };
  if (retype?.outcome === 'failed') return { tone: 'wrong', title: strings.feedbackWrong, line: rightAnswer(question), verdict: 'wrong' };
  const feedback = answerFeedback(question, unhelped(answer));
  if (retry === null) return helpedOr(answer, feedback, false);
  if (feedback.tone === 'wrong' && gaveUp(answer)) return alternativeFeedback(question);
  // Phase 45 (spec D1, review I1). Another accepted word again, or the first answer
  // sent again: the second try asked for the practised word, so it is not "right";
  // nor wrong, since it was just told it fits, and its input is not coloured.
  if (feedback.verdict === 'alternative' || (feedback.tone === 'wrong' && repeats(question, answer, retry))) {
    return stillOtherFeedback(question);
  }
  return helpedOr(answer, feedback, true);
}

/** Phase 55 (spec D6). The answer as its text alone: `helped` changes how it
 *  is recorded, not what its text is. Phase 56 (spec D8): a judged or heard
 *  answer keeps its verdict. */
function unhelped(answer: CardAnswer): CardAnswer {
  if (!('helped' in answer)) return answer;
  if ('judged' in answer) return { text: answer.text, judged: answer.judged };
  if ('heard' in answer) return { heard: answer.heard, verdict: answer.verdict };
  return 'text' in answer ? { text: answer.text } : answer;
}

function helped(answer: CardAnswer): boolean {
  return 'helped' in answer && answer.helped === true;
}

/** Phase 55 (spec D7). A right text found with help: neither green nor red.
 *  On a second try a near miss is one too (review M1): core records it `wrong`,
 *  and no retype follows a second try. A first try's near miss keeps its banner,
 *  whose title its retype shows. */
function helpedOr(answer: CardAnswer, feedback: Feedback, secondTry: boolean): Feedback {
  // Phase 56 (spec D8): a spoken answer understood is the word, said.
  const right =
    feedback.verdict === 'exact' ||
    feedback.verdict === 'alternative' ||
    feedback.verdict === 'understood' ||
    (secondTry && feedback.verdict === 'near_miss');
  if (!helped(answer) || !right) return feedback;
  return { tone: 'other', title: strings.feedbackHelped, line: null, verdict: null };
}

function stillOtherFeedback(question: Question): Feedback {
  const title = question.type === 'typed_meaning' ? strings.feedbackStillOtherSense : strings.feedbackStillOther;
  return { tone: 'other', title, line: alternativeFeedback(question).line, verdict: null };
}

function gaveUp(answer: CardAnswer): boolean {
  return 'pass' in answer || ('text' in answer && answer.text.trim() === '');
}

/** Phase 42 (review I1). The first answer typed again: it was told it is right a
 *  moment ago (a fit-checked gap word, a translation sent unchanged), and a
 *  second try is judged without that check, so it is never shown as wrong. */
function repeats(question: Question, answer: CardAnswer, retry: PendingRetry): boolean {
  if (!('text' in answer)) return false;
  const same = question.type === 'typed_meaning' ? normaliseHebrew : normaliseTyped;
  return same(answer.text) === same(retry.answer);
}

/** Today's banner for another accepted word on this card: another sense on a
 *  meaning card; elsewhere the practised word, which on a translation is the
 *  word and not the whole sentence (phase 27 D6). */
function alternativeFeedback(question: Question): Feedback {
  if (question.type === 'typed_meaning') {
    return { tone: 'correct', title: strings.feedbackOtherSense, line: question.meaning, verdict: 'alternative' };
  }
  const word = question.type === 'sentence_translation' ? question.answer : rightAnswer(question);
  return { tone: 'correct', title: strings.feedbackAlternative, line: word, verdict: 'alternative' };
}

function answerFeedback(question: Question, answer: CardAnswer): Feedback {
  if ('board' in answer) {
    if (question.type !== 'matching') throw new Error(`a board answer for a ${question.type} card`);
    const start = question.board.question_ids.indexOf(question.id);
    const right = answer.board.filter((meaning, i) => meaning === question.board.correct_options[start + i]).length;
    return {
      tone: right === answer.board.length ? 'correct' : 'wrong',
      title: strings.boardResult(right, answer.board.length),
      line: null,
      verdict: null,
    };
  }
  // Phase 25 (spec D7). The server's verdict is the answer's: this never
  // re-judges the transcript, so a skewed bundle cannot disagree with it.
  if ('heard' in answer) {
    if (answer.verdict === 'alternative') return alternativeFeedback(question);
    return { tone: 'correct', title: strings.feedbackHeard, line: answer.heard, verdict: 'understood' };
  }
  // Phase 27 (spec D12). A judged card's verdict is the server's: the app
  // never judges it, so it only words the banner.
  if ('judged' in answer) {
    // A translation's banner names the practised word, not the whole sentence;
    // the card itself shows the reference after every verdict (spec D6).
    if (question.type === 'sentence_translation') {
      const word = question.answer;
      if (answer.judged === 'wrong') return { tone: 'wrong', title: strings.feedbackWrong, line: word, verdict: 'wrong' };
      if (answer.judged === 'near_miss') return { tone: 'correct', title: strings.feedbackNearMiss, line: word, verdict: 'near_miss' };
      if (answer.judged === 'alternative') return alternativeFeedback(question);
      return { tone: 'correct', title: strings.feedbackCorrect, line: null, verdict: answer.judged };
    }
    if (question.type !== 'typed_meaning') throw new Error(`a judged answer for a ${question.type} card`);
    const meaning = question.meaning;
    if (answer.judged === 'wrong') return { tone: 'wrong', title: strings.feedbackWrong, line: meaning, verdict: 'wrong' };
    if (answer.judged === 'alternative') return alternativeFeedback(question);
    return normaliseHebrew(answer.text) === normaliseHebrew(meaning)
      ? { tone: 'correct', title: strings.feedbackCorrect, line: null, verdict: answer.judged }
      : { tone: 'correct', title: strings.feedbackSavedMeaning, line: meaning, verdict: answer.judged };
  }
  const record = evaluate(question, answer);
  const verdict = record.verdict ?? null;
  const right = rightAnswer(question);
  if (!record.is_correct) return { tone: 'wrong', title: strings.feedbackWrong, line: right, verdict };
  if (verdict === 'near_miss') return { tone: 'correct', title: strings.feedbackNearMiss, line: right, verdict };
  if (verdict === 'alternative') return alternativeFeedback(question);
  return { tone: 'correct', title: strings.feedbackCorrect, line: null, verdict };
}

/** Phase 34 (spec D9). What a card held for its second try says: the first
 *  answer was right, and another saved word, or on a typed meaning another
 *  meaning, is there to find. Phase 38 (spec D3): on a typed gap, that another
 *  word was meant and the Hebrew sentence shows which. The card's type decides,
 *  so `wording` keeps the two values every app build can read. */
export function retryNotice(type: Question['type'], pending: PendingRetry): { right: string; again: string } {
  return {
    right: strings.retryRight(pending.answer),
    again:
      type === 'cloze_typed'
        ? strings.retryMeantAnother
        : pending.wording === 'meaning'
          ? strings.retryAnotherMeaning
          : strings.retryAnotherWord,
  };
}

/** Phase 34 (spec D9). What the input holds on a second try: nothing, except
 *  on a sentence translation, which keeps the first sentence so the learner
 *  only changes the word. */
export function retryText(type: Question['type'], pending: PendingRetry | null): string {
  return pending !== null && type === 'sentence_translation' ? pending.answer : '';
}

/** Phase 41 (spec D3). A typed gap answer the phone calls wrong, not empty: the
 *  server is asked whether it fills the gap, so its banner waits for the answer. */
export function checksFit(question: Question, answer: CardAnswer): boolean {
  if (question.type !== 'cloze_typed' || !('text' in answer) || 'judged' in answer || answer.text.trim() === '') return false;
  // Phase 56 (spec D4): a helped answer is a miss whatever the model says.
  if ('helped' in answer && answer.helped === true) return false;
  return evaluate(question, answer).verdict === 'wrong';
}

/** Phase 34 (spec D9). Whether an answer the phone judges opens a second try.
 *  Its banner would name the saved word, so the card waits for the server to
 *  hold it instead. The `evaluate` the server runs decides, as for the banner. */
export function opensRetry(question: Question, answer: CardAnswer): boolean {
  if ('board' in answer || 'heard' in answer || 'judged' in answer) return false;
  return evaluate(question, answer).retry_state === 'pending';
}
