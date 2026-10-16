/**
 * Phase 55 (spec D7). The typed card's help: each press reveals one more
 * character of the answer from its start, in a line apart from the input. A
 * space or an apostrophe comes with the letter after it, so no press shows
 * nothing new; an accent written as its own mark comes with its letter; and an
 * apostrophe that ends the form (`po'`) comes with the last press.
 */
const JOINS_NEXT = /[\s'’‘ʼ]/u;
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

/** Once the whole form is shown, the help button is done. */
export function allRevealed(answer: string, presses: number): boolean {
  return presses >= steps(answer).length;
}
