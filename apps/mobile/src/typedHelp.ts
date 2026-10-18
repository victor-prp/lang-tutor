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

/** Phase 59 (spec D3). The presses that show the whole form: a tap on the practised word. */
export function wholeForm(answer: string): number {
  return steps(answer).length;
}

/** Where each press's reveal ends in the answer: the end offset of each step. */
function stepEnds(answer: string): number[] {
  let end = 0;
  return steps(answer).map((step) => (end += step.length));
}

type Folded = { ch: string; start: number; end: number };

const HEBREW_POINT = /[\u0591-\u05BD\u05BF-\u05C7]/u;
const CYRILLIC = /\p{Script=Cyrillic}/u;
/** What the checker drops from the end of a typed answer (normaliseTyped). */
const TRAILING = /[\s.,;:!?…]/u;

/**
 * Phase 63 (spec D3). A text cut into the characters help compares, each with
 * where it sits in the text, folded as the checker folds a whole answer:
 * normaliseTyped (lowercase, the typographic apostrophes as one, a Cyrillic
 * stress dropped, a run of spaces as one) or, on a Hebrew meaning,
 * normaliseHebrew (points and format marks dropped, a maqaf or any other
 * punctuation or symbol read as a space). An accent stays: it is spelling.
 */
function fold(text: string, hebrew: boolean): Folded[] {
  const out: Folded[] = [];
  let offset = 0;
  for (const raw of text) {
    const start = offset;
    offset += raw.length;
    const last = out[out.length - 1];
    const dropped = hebrew ? HEBREW_POINT.test(raw) || /\p{Cf}/u.test(raw) : raw === '\u0301' && last !== undefined && CYRILLIC.test(last.ch);
    if (dropped) {
      if (last) last.end = offset;
      continue;
    }
    if (!hebrew && MARK.test(raw) && last) {
      last.ch = (last.ch + raw).normalize('NFC');
      last.end = offset;
      continue;
    }
    const space = /\s/u.test(raw) || (hebrew && /[\p{P}\p{S}]/u.test(raw));
    if (space) {
      if (last?.ch === ' ') last.end = offset;
      else out.push({ ch: ' ', start, end: offset });
      continue;
    }
    out.push({ ch: raw.normalize('NFC').toLowerCase().replace(/[’‘ʼ]/u, "'"), start, end: offset });
  }
  return out;
}

/** How far a typed text agrees with the answer: the answer's offset it covers,
 *  or the typed offset of its first wrong character. What the checker ignores at
 *  the end of a typed answer (a space, a full stop) is not wrong. */
function compare(answer: string, typed: string, hebrew: boolean): { covered: number } | { wrongAt: number } {
  const a = fold(answer, hebrew);
  const t = fold(typed, hebrew);
  let i = 0;
  while (i < t.length && i < a.length && t[i].ch === a[i].ch) i++;
  if (i < t.length && !t.slice(i).every((char) => TRAILING.test(char.ch))) return { wrongAt: t[i].start };
  return { covered: i === 0 ? 0 : a[i - 1].end };
}

/** The steps a typed right start already holds in full. */
function stepsCovered(ends: number[], covered: number): number {
  return ends.filter((end) => end <= covered).length;
}

/**
 * Phase 63 (spec D3). A press of help on a typed card. A wrong character typed:
 * `markFrom`, its offset in the typing, and nothing more given. Otherwise the
 * step after the typing, or after what was already given, whichever is further.
 */
export function pressTyped(answer: string, typed: string, given: number, hebrew: boolean): { given: number; markFrom: number | null } {
  const result = compare(answer, typed, hebrew);
  if ('wrongAt' in result) return { given, markFrom: result.wrongAt };
  const ends = stepEnds(answer);
  return { given: Math.min(ends.length, Math.max(given, stepsCovered(ends, result.covered)) + 1), markFrom: null };
}

/**
 * Phase 63 (spec D3). What shows in grey after the caret: the given letters not
 * yet typed, and whether the answer goes on beyond them (a `…`). Null while the
 * typing is not a start of the answer: nothing shows until the next press.
 */
export function typedHint(answer: string, typed: string, given: number, hebrew: boolean): { ghost: string; more: boolean } | null {
  const result = compare(answer, typed, hebrew);
  if ('wrongAt' in result) return null;
  const ends = stepEnds(answer);
  const givenEnd = given > 0 ? ends[Math.min(given, ends.length) - 1] : 0;
  const ghost = givenEnd > result.covered ? answer.slice(result.covered, givenEnd) : '';
  return { ghost, more: Math.max(result.covered, givenEnd) < answer.length };
}

/** Phase 63 (spec D3). Help has nothing left to give: the typing is a right
 *  start and every step is typed or given. A wrong typing can still be marked. */
export function typedHelpDone(answer: string, typed: string, given: number, hebrew: boolean): boolean {
  const result = compare(answer, typed, hebrew);
  if ('wrongAt' in result) return false;
  const ends = stepEnds(answer);
  return Math.max(given, stepsCovered(ends, result.covered)) >= ends.length;
}
