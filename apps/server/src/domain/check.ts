import type { LlmCheck } from '@lang-tutor/core/api';
import { LlmCheckSchema } from '@lang-tutor/core/api/schemas';
import { judgeTyped, normaliseHebrew, withoutLeadingWord, type TypedTarget } from '@lang-tutor/core/domain';

import { comparable } from './distractors';
import { LANGUAGES, type LanguageCode } from './languages';
import { dropNulls, unfence } from './translation';

/**
 * Phase 34 (spec D5). The checker: one more call after the batch and the context
 * call, a separate prompt rather than the writer checking itself, that reads the
 * session's cards as a learner would. Pure (ADR 0001 R3): the prompt, the parse,
 * and what each answer means for a card. services/sessions.ts calls the model and
 * decides what it costs: an unreadable answer fails the batch, as an unreadable
 * generation does, and pg-boss retries it.
 *
 * Five questions, one per kind of item:
 * - a choice card's wrong options: could this also translate the word, in any
 *   common use? A yes drops the option, and a spare takes its place (D4);
 * - a cloze choice's wrong options: does the sentence still read correctly with
 *   this in the gap? (the sentence, not the word's meaning, makes an option right);
 * - a target-language context sentence: what does its marked word mean here?
 * - a Hebrew context sentence: which target words fit its marked word here?
 * - a sentence card's Hebrew: what is its natural translation?
 */

/** In the instruction verbatim, so MockServer can tell this call apart.
 *  Changing the wording means changing the stubs. */
export const CHECK_MARKER = 'a second opinion';

/** A context's key beside its card's: q1 is the card's options, gap or sentence, q1c its context. */
export const contextKeyOf = (key: string): string => `${key}c`;

export type CheckItem =
  /** The options of a card that shows `word` alone. */
  | { key: string; task: 'choice'; word: string; options: string[] }
  /** The options of a sentence with a gap, `sentence` holding ___ where it is. */
  | { key: string; task: 'gap'; sentence: string; options: string[] }
  /** A target-language sentence and its marked `word`. `candidates` are the
   *  readings the dictionary knows for the word, its card's among them. */
  | { key: string; task: 'meaning'; sentence: string; word: string; candidates: string[] }
  /** A Hebrew sentence and its marked `word`. */
  | { key: string; task: 'words'; sentence: string; word: string }
  /** A sentence card's Hebrew. */
  | { key: string; task: 'translate'; sentence: string };

/** Structurally LlmJsonRequest; services/sessions.ts is where the two meet. */
export type CheckPrompt = { system: string; user: string; schema: typeof LlmCheckSchema };

function language(code: string) {
  const found = LANGUAGES[code as LanguageCode];
  if (!found) throw new Error(`no language ${code}`);
  return found;
}

/** `from` is the language learned, `to` the learner's own. */
export function buildCheckPrompt(items: readonly CheckItem[], from: string, to: string): CheckPrompt {
  const learned = language(from);
  const own = language(to);
  const system = [
    `You are ${CHECK_MARKER} on the cards of a ${learned.name} vocabulary quiz for a ${own.name}-speaking learner.`,
    'Another writer made the cards. Check each one as a careful native speaker would, never assuming the writer was right.',
    'Return JSON only, matching the supplied schema.',
    'Each item has a task:',
    '- "choice": a card shows word alone, with no sentence, and the learner picks its translation among options. In options, write one true or false per option, in the order given: true when the option is a correct translation of word in any common sense or use of word, so that a learner who picked it would be right; false when it is wrong in every common sense.',
    `- "gap": sentence is a ${learned.name} sentence with a gap, written ___. In gap_fits, write one true or false per option, in the order given: true when the sentence with that option in the gap is still correct and makes sense, whatever it then means; false when it does not.`,
    `- "meaning": sentence is a ${learned.name} sentence and word is a word in it. In context_meaning, write the ${own.name} word that translates word as it is used in this sentence, in its dictionary form. When one of candidates means that, write it exactly as candidates writes it; otherwise write your own.`,
    `- "words": sentence is a ${own.name} sentence and word is a word in it. In context_words, list every ${learned.name} word or phrase that translates word as it is used in this sentence, in its dictionary form, the most natural first.`,
    `- "translate": sentence is a ${own.name} sentence. In natural_translation, write it as a native speaker of ${learned.name} would say it in everyday speech: the idiom or the word such a speaker reaches for first, never a word-for-word rendering of the ${own.name} words.`,
    'Leave every field the item’s task does not name empty.',
    'Answer every item, using its key exactly as given.',
    ...own.writing,
    ...learned.writing,
  ].join('\n');

  const user = JSON.stringify({
    items: items.map((item) => {
      switch (item.task) {
        case 'choice':
          return { key: item.key, task: item.task, word: item.word, options: item.options };
        case 'gap':
          return { key: item.key, task: item.task, sentence: item.sentence, options: item.options };
        case 'meaning':
          return { key: item.key, task: item.task, sentence: item.sentence, word: item.word, candidates: item.candidates };
        case 'words':
          return { key: item.key, task: item.task, sentence: item.sentence, word: item.word };
        case 'translate':
          return { key: item.key, task: item.task, sentence: item.sentence };
      }
    }),
  });
  return { system, user, schema: LlmCheckSchema };
}

/** `null` means unreadable; the caller decides what that costs (the batch). A
 *  null field is "none", as in the batch. */
export function parseCheck(raw: string): LlmCheck | null {
  let json: unknown;
  try {
    json = JSON.parse(unfence(raw));
  } catch {
    return null;
  }
  const result = LlmCheckSchema.safeParse(dropNulls(json));
  return result.success ? result.data : null;
}

/** What the checker said about one item. */
export type CheckFinding =
  | { task: 'choice' | 'gap'; alsoRight: boolean[] }
  | { task: 'meaning'; meaning: string }
  | { task: 'words'; words: string[] }
  | { task: 'translate'; translation: string };

export type CheckReading = { ok: true; byKey: Map<string, CheckFinding> } | { ok: false; reason: string };

/**
 * The answer, item by item. A choice or gap item whose booleans are missing, or
 * do not number its options, is unreadable: which option is right could only be
 * guessed, so the batch fails and is retried. A sentence item with no answer
 * reads as an empty one, which the rules below then refuse: a hint the checker
 * did not confirm is dropped, never kept on trust. Keys the model added are
 * ignored, and of two answers for one key the first counts.
 */
export function readCheck(items: readonly CheckItem[], answer: LlmCheck): CheckReading {
  const answered = new Map<string, LlmCheck['items'][number]>();
  for (const item of answer.items) if (!answered.has(item.key)) answered.set(item.key, item);
  const byKey = new Map<string, CheckFinding>();
  for (const item of items) {
    const got = answered.get(item.key);
    switch (item.task) {
      case 'choice':
      case 'gap': {
        const said = item.task === 'choice' ? got?.options : got?.gap_fits;
        if (!said || said.length !== item.options.length) {
          return { ok: false, reason: `the checker did not say which of ${item.key}'s ${item.options.length} options are right` };
        }
        byKey.set(item.key, { task: item.task, alsoRight: said });
        break;
      }
      case 'meaning':
        byKey.set(item.key, { task: 'meaning', meaning: got?.context_meaning?.trim() ?? '' });
        break;
      case 'words':
        byKey.set(item.key, { task: 'words', words: (got?.context_words ?? []).map((word) => word.trim()).filter((word) => word !== '') });
        break;
      case 'translate':
        byKey.set(item.key, { task: 'translate', translation: got?.natural_translation?.trim() ?? '' });
        break;
    }
  }
  return { ok: true, byKey };
}

/** One reading the checker wrote, split where it listed several. */
const readingsOf = (text: string): string[] =>
  text
    .split(/[,;/]|\s+או\s+|\s+or\s+/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');

/** Hebrew compared as the meaning judge's rule compares it, and any other language under `comparable`. */
const sameMeaning = (a: string, b: string): boolean => {
  const x = normaliseHebrew(a).toLowerCase();
  return x !== '' && (x === normaliseHebrew(b).toLowerCase() || comparable(a) === comparable(b));
};

/**
 * Spec D5, D6 (a target-language context). The sentence pins its card's sense
 * when the checker's reading of the marked word is one of the gloss's meanings:
 * its key, its alternatives, and its renderings. Anything else, or nothing,
 * drops the sentence.
 */
export function meaningFits(meaning: string, glossMeanings: readonly string[]): boolean {
  return readingsOf(meaning).some((reading) => glossMeanings.some((own) => sameMeaning(reading, own)));
}

/**
 * Spec D5, D6 (a Hebrew context). The sentence pins its card's sense when one
 * of the target words the checker reads in the marked word is one the card
 * accepts, by the card's own judge: its form or lemma (exact), an accepted
 * answer (alternative), or a slip of one (near miss). None of them, or none
 * named, drops the sentence.
 */
export function wordsFit(words: readonly string[], card: TypedTarget): boolean {
  return words.some((word) => judgeTyped(card, word) !== 'wrong');
}

/** Letters a word of a translation may add to a word it uses: -s, -ed, -ing, -ies. */
const INFLECTION_LETTERS = 3;
/** Below this a word is matched exactly: a short stem begins too many words. */
const STEM_MIN_LETTERS = 3;

const wordsOf = (text: string): string[] =>
  comparable(text)
    .replace(/[’‘ʼ]/gu, "'")
    .split(/[^\p{L}\p{M}\p{N}']+/u)
    .filter((word) => word !== '');

/** A word of the translation is `sought`, or `sought` with an ending. */
const usesWord = (word: string, sought: string): boolean =>
  word === sought ||
  ([...sought].length >= STEM_MIN_LETTERS && word.startsWith(sought) && [...word].length - [...sought].length <= INFLECTION_LETTERS);

/**
 * Spec D5, D8 (a sentence card). The practised word is the natural choice when
 * the sentence's natural translation uses it, or one of its accepted answers:
 * a candidate's words, in order and whole, a leading article or "to" left off,
 * each word allowed a short ending (combine, combined; pick up, picked up). An
 * irregular form the candidates do not list (blow, blew) is not found, and the
 * card takes phase 27's degraded path: a typed translation, never a wrong one.
 */
export function translationUses(translation: string, candidates: readonly string[]): boolean {
  const words = wordsOf(translation);
  return candidates.some((candidate) => {
    const sought = wordsOf(withoutLeadingWord(comparable(candidate)));
    return (
      sought.length > 0 &&
      words.some((_, at) => sought.every((part, offset) => at + offset < words.length && usesWord(words[at + offset], part)))
    );
  });
}

/** Spec D4, D5. The options the checker did not call right, in the order asked. */
export const wrongOnly = (options: readonly string[], alsoRight: readonly boolean[]): string[] =>
  options.filter((_, index) => !alsoRight[index]);

/** Spec D5, D6. The readings a "meaning" item offers the checker: every meaning
 *  the dictionary knows for the word and its homographs, the card's own among
 *  them, once each and in a fixed order, so where the card's stands says nothing. */
export function readingCandidates(meanings: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const meaning of meanings) {
    const text = meaning.trim();
    const key = comparable(text);
    if (key !== '' && !seen.has(key)) seen.set(key, text);
  }
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, text]) => text);
}
