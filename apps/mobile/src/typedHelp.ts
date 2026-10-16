import type { Question } from '@lang-tutor/core/api';

/**
 * Phase 55 (spec D7). The typed card's help: each press reveals one more
 * character of the answer from its start, in a line apart from the input. A
 * space or an apostrophe comes with the letter after it, so no press shows
 * nothing new; an accent written as its own mark comes with its letter; and an
 * apostrophe that ends the form (`po'`) comes with the last press.
 *
 * Phase 56 (spec D1): so does every punctuation mark (a comma, a hyphen, a
 * Hebrew meaning's `!`), and the modifier apostrophe, which Unicode calls a letter.
 */
const JOINS_NEXT = /[\s\p{P}ʼ]/u;
const MARK = /\p{M}/u;

/** The answer cut into what each press reveals. */
function steps(answer: string): string[] {
  const out: string[] = [];
  let pending = '';
  for (const char of answer) {
    if (MARK.test(char) && pending === '' && out.length > 0) out[out.length - 1] += char;
    else if (JOINS_NEXT.test(char)) pending += char;
    else {
      out.push(pending + char);
      pending = '';
    }
  }
  if (pending !== '') {
    if (out.length > 0) out[out.length - 1] += pending;
    else out.push(pending);
  }
  return out;
}

export function revealed(answer: string, presses: number): string {
  return steps(answer).slice(0, Math.max(0, presses)).join('');
}

/** Phase 56 (spec D1). What help reveals on a card: the stored meaning on a
 *  typed meaning, the heard form on a dictation, the word asked for on a typed
 *  or say translation, a typed gap and a sentence translation (its practised
 *  word, never the reference sentence). Null on a card with no help. */
export function helpText(question: Question): string | null {
  switch (question.type) {
    case 'typed_meaning':
      return question.meaning;
    case 'dictation':
      return question.question;
    case 'typed_translation':
    case 'say_translation':
    case 'cloze_typed':
    case 'sentence_translation':
      return question.answer;
    default:
      return null;
  }
}

/** Once the whole form is shown, the help button is done. */
export function allRevealed(answer: string, presses: number): boolean {
  return presses >= steps(answer).length;
}
