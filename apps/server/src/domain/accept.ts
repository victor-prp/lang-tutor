import type { LlmAccept } from '@lang-tutor/core/api';
import { LlmAcceptSchema } from '@lang-tutor/core/api/schemas';
import { judgeTyped } from '@lang-tutor/core/domain';

import { comparable } from './distractors';
import { LANGUAGES, isInScript, type LanguageCode } from './languages';
import { unfence } from './translation';

/**
 * Phase 34 (spec D1, D2). The accept task: every right answer to a typed or
 * spoken card whose prompt is one rendering, asked once per rendering and
 * stored, instead of afresh inside every session's batch. Also the form of the
 * headword that agrees with the rendering (`ore` for שעות), which the card asks
 * for instead of the saved form. Pure (ADR 0001 R3): the prompt, the parse and
 * the validation. services/translations.ts calls the model and stores the list.
 */

/** In the instruction verbatim, so MockServer can tell this call apart.
 *  Changing the wording means changing the stubs. */
export const ACCEPT_MARKER = 'every right translation';

/** The most answers a rendering keeps (dict_var_translations_accepted_answers_cap). */
export const MAX_ACCEPTED = 10;

/** Structurally LlmJsonRequest; services/translations.ts is where the two meet. */
export type AcceptPrompt = { system: string; user: string; schema: typeof LlmAcceptSchema };

export type AcceptInput = {
  /** The variant's form: what the card asks for today. */
  form: string;
  lemma: string;
  partOfSpeech: string;
  /** The rendering: the explanation-language text the card shows. */
  rendering: string;
  /** The saved example in the target language, and its translation: the sense. */
  example: string | null;
  exampleTranslation: string | null;
  target: LanguageCode;
  explanation: LanguageCode;
};

export function buildAcceptPrompt(input: AcceptInput): AcceptPrompt {
  const target = LANGUAGES[input.target];
  const explanation = LANGUAGES[input.explanation].name;
  const example = input.example
    ? [
        `Its sense is the one in this example sentence: "${input.example}"` +
          (input.exampleTranslation ? `, in ${explanation} "${input.exampleTranslation}".` : '.'),
      ]
    : [];
  // The examples below are deliberately not the eval cases (ho/יש לי, ore/שעות,
  // lose my temper), so the evals measure the rules rather than recall of them.
  const system = [
    `A ${explanation}-speaking learner of ${target.name} is shown the ${explanation} below on a practice card`,
    `and asked to write it in ${target.name}.`,
    'Return JSON only, matching the supplied schema.',
    `The ${explanation} is the dictionary's rendering of the ${target.name} ${input.partOfSpeech} "${input.lemma}",`,
    `in its form "${input.form}", in one sense.`,
    ...example,
    `In "answers", list ${ACCEPT_MARKER} of the ${explanation} into ${target.name} in this sense:`,
    'every word or phrase a teacher would mark right on this card.',
    `Only this sense: never a word for another meaning of "${input.lemma}" or of the ${explanation}.`,
    `Inflect every answer to agree with the ${explanation}: the same number, person, gender and tense.`,
    'Never write a placeholder such as "one\'s", "someone" or "qualcuno" in an answer: write it out, one answer',
    'for each person it stands for, the first person first. Not "make up one\'s mind" but "make up my mind",',
    '"make up your mind", "make up his mind", and so on.',
    `Where the ${explanation} implies its subject, as a conjugated verb does, give the answer both without`,
    'and with its subject pronoun: for דיברתי in Italian, both "ho parlato" and "io ho parlato".',
    `Write every answer in ${target.name}, never in ${explanation}. At most ten answers, the most common first.`,
    `In "answer_form", give the form of "${input.lemma}" that agrees with the ${explanation} in number and`,
    `person, the one a learner answering this card should write: a card showing ספרים for "libro" answers`,
    `"libri". Give null when "${input.form}" already agrees.`,
    ...target.writing,
  ].join(' ');
  // The rendering is the dictionary's own text, and stays in its own part.
  return { system, user: input.rendering, schema: LlmAcceptSchema };
}

/** `null` means unreadable; the caller decides what that costs. An absent or
 *  empty answer form is null: a provider that drops a null field, or writes it
 *  as "", has said "none", and that must not cost the answers beside it. */
export function parseAccept(raw: string): LlmAccept | null {
  let json: unknown;
  try {
    json = JSON.parse(unfence(raw));
  } catch {
    return null;
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return null;
  const form = (json as { answer_form?: unknown }).answer_form;
  const result = LlmAcceptSchema.safeParse({
    ...json,
    answer_form: form === undefined || (typeof form === 'string' && form.trim() === '') ? null : form,
  });
  return result.success ? result.data : null;
}

// A placeholder stands for a word the learner would write: the prompt asks for
// each written out, so an entry that keeps one is not an answer. Russian's
// declines, and each case is a placeholder.
const PLACEHOLDERS = [/\bone['’]s\b/iu, /\bsomeone\b/iu, /\bqualcuno\b/iu, /(?:^|[^\p{L}])(?:кто|кого|кому|кем|ком)-то(?![\p{L}])/iu];
const hasPlaceholder = (text: string): boolean => PLACEHOLDERS.some((pattern) => pattern.test(text));

/** What a rendering's answers may hold: written in the target language's script
 *  alone (so never the explanation's), and with no placeholder. */
const writable = (text: string, target: LanguageCode): boolean => isInScript(text, target) && !hasPlaceholder(text);

/** One answer as another: the same under `comparable`, or the same to the typed
 *  judge, which reads `to blow up` as `blow up` (its leading "to" or article). */
const sameAnswer = (a: string, b: string): boolean =>
  comparable(a) === comparable(b) || judgeTyped({ answer: b, lemma: b, alternatives: [] }, a) === 'exact';

/**
 * Never a refusal: the list only widens what a card accepts, so a bad entry is
 * dropped and the rest kept. Each answer trimmed; empty ones, the form itself,
 * anything outside the target script and anything keeping a placeholder
 * dropped; one of each (sameAnswer, so `comparable` and the judge's leading
 * word); at most MAX_ACCEPTED, in the order given. The answer form is null
 * unless it is writable and is not the form: `to blow up` for `blow up` would
 * make a card ask for the "to".
 */
export function validateAccept(
  input: { form: string; lemma: string; target: LanguageCode; explanation: LanguageCode },
  answer: LlmAccept,
): { answers: string[]; answerForm: string | null } {
  const answers: string[] = [];
  for (const raw of answer.answers) {
    const text = raw.trim();
    if (comparable(text) === '' || !writable(text, input.target)) continue;
    if ([input.form, ...answers].some((kept) => sameAnswer(text, kept))) continue;
    answers.push(text);
    if (answers.length === MAX_ACCEPTED) break;
  }
  const answerForm = answer.answer_form?.trim() ?? '';
  const agreeing =
    comparable(answerForm) !== '' && !sameAnswer(answerForm, input.form) && writable(answerForm, input.target) ? answerForm : null;
  return { answers, answerForm: agreeing };
}
