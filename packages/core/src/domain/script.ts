import type { LanguageCode } from '../api/types';
import type { QuestionType } from './quiz';

/** Phase 39 (spec D7). The alphabet each language is written in. */
export const SCRIPTS: Record<LanguageCode, 'Latin' | 'Hebrew' | 'Cyrillic'> = {
  en: 'Latin',
  it: 'Latin',
  ru: 'Cyrillic',
  he: 'Hebrew',
};

/** The types a learner answers by typing, and so can type in the wrong alphabet. Letter tiles are
 *  built from given letters and are not among them. */
export type TypedAnswerType =
  | 'typed_translation'
  | 'cloze_typed'
  | 'sentence_translation'
  | 'dictation'
  | 'say_translation'
  | 'typed_meaning';

const TYPED: ReadonlySet<QuestionType> = new Set<TypedAnswerType>([
  'typed_translation',
  'cloze_typed',
  'sentence_translation',
  'dictation',
  'say_translation',
  'typed_meaning',
]);

export function isTypedAnswerType(type: QuestionType): type is TypedAnswerType {
  return TYPED.has(type);
}

/** The language a typed card is answered in: the learner's on a typed meaning, the target's on
 *  every other. */
export function answerLanguage(type: TypedAnswerType, target: LanguageCode, learner: LanguageCode): LanguageCode {
  return type === 'typed_meaning' ? learner : target;
}

// One regex per script: \p{Script=…} needs a literal in the pattern.
const IN_SCRIPT: Record<'Latin' | 'Hebrew' | 'Cyrillic', RegExp> = {
  Latin: /\p{Script=Latin}/u,
  Hebrew: /\p{Script=Hebrew}/u,
  Cyrillic: /\p{Script=Cyrillic}/u,
};

/** At least one letter, and none of them in the language's script. Empty text is not a wrong
 *  script: it gives up. */
export function wrongScript(text: string, language: LanguageCode): boolean {
  if (!/\p{L}/u.test(text)) return false;
  return !IN_SCRIPT[SCRIPTS[language]].test(text);
}
