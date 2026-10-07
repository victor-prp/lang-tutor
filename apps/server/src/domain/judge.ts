import type { SentenceTranslationQuestion, TypedVerdict } from '@lang-tutor/core/api';
import { LlmMeaningJudgeSchema, LlmTranslationJudgeSchema } from '@lang-tutor/core/api/schemas';
import { normaliseHebrew, normaliseTyped, type JudgedQuestion } from '@lang-tutor/core/domain';

import { LANGUAGES, type LanguageCode } from './languages';
import { unfence } from './translation';

/**
 * Phase 27 (spec D3, D4). The pure half of judging an open answer: the rules
 * that decide without a model, what the model is told, and how its answer is
 * read. services/sessions.ts calls the model and decides what a failure costs.
 */

/** Part of every judge instruction, and what MockServer matches to tell this
 *  call from the others. Changing the wording means changing the stubs. */
export const JUDGE_MARKER = "judge the learner's answer";

/** What the meaning judge is told about the card: the word, and the sense its
 *  saved example pins. The example is absent for a saved sense without one. */
export type MeaningJudgeContext = {
  language: LanguageCode;
  /** The enrollment's source language: the one the learner reads and types in. */
  explanation: LanguageCode;
  form: string;
  lemma: string;
  partOfSpeech: string;
  meaning: string;
  example: string | null;
  exampleTranslation: string | null;
};

/** Spec D3 step 2. Empty text is "show me the answer"; the stored meaning is
 *  right as typed. Null: only the model can tell. */
export function meaningRuleVerdict(meaning: string, text: string): TypedVerdict | null {
  const typed = normaliseHebrew(text);
  if (typed === '') return 'wrong';
  return typed === normaliseHebrew(meaning) ? 'exact' : null;
}

export function buildMeaningJudgePrompt(context: MeaningJudgeContext, answer: string) {
  const name = LANGUAGES[context.language].name;
  const source = LANGUAGES[context.explanation].name;
  const system = [
    `Your task: ${JUDGE_MARKER}. A ${source}-speaking learner of ${name} was shown a ${name} word and typed its meaning in ${source}.`,
    'The meaning practised is saved_meaning, in the sense the example shows.',
    'Return JSON only, matching the supplied schema, with one field, verdict:',
    '- "right": the answer means the same as saved_meaning in this sense. Accept a synonym, another form, tense or person of it (for example לדבר, מדבר, דיבר), with or without a prefix such as ה, ל, ו or ש, with or without niqqud, and with small Hebrew spelling slips.',
    '- "other_sense": the answer is a correct meaning of the word, but of a different sense than the one practised.',
    '- "wrong": anything else, including an answer that is only related, too general, or the meaning of another word.',
  ].join('\n');
  const user = JSON.stringify({
    word: context.form,
    lemma: context.lemma,
    part_of_speech: context.partOfSpeech,
    saved_meaning: context.meaning,
    example: context.example,
    example_translation: context.exampleTranslation,
    answer,
  });
  return { system, user, schema: LlmMeaningJudgeSchema };
}

const MEANING_VERDICTS: Record<'right' | 'other_sense' | 'wrong', TypedVerdict> = {
  right: 'exact',
  other_sense: 'alternative',
  wrong: 'wrong',
};

/** The model's verdict as a typed verdict. Null when the answer is empty (no
 *  content is no verdict here) or cannot be read. */
export function parseMeaningJudge(raw: string): TypedVerdict | null {
  if (raw.trim() === '') return null;
  try {
    const parsed = LlmMeaningJudgeSchema.safeParse(JSON.parse(unfence(raw)));
    return parsed.success ? MEANING_VERDICTS[parsed.data.verdict] : null;
  } catch {
    return null;
  }
}

export type JudgeContext = MeaningJudgeContext;

/** The translation card's rule: empty is "show me the answer"; the reference
 *  is right as typed, whatever its case or full stop. Null: only the model can tell. */
export function translationRuleVerdict(reference: string, text: string): TypedVerdict | null {
  const typed = normaliseTyped(text);
  if (typed === '') return 'wrong';
  return typed === normaliseTyped(reference) ? 'exact' : null;
}

export function buildTranslationJudgePrompt(question: SentenceTranslationQuestion, context: JudgeContext, answer: string) {
  const name = LANGUAGES[context.language].name;
  const source = LANGUAGES[context.explanation].name;
  const system = [
    `Your task: ${JUDGE_MARKER}. A ${source}-speaking learner of ${name} was shown a ${source} sentence and typed its translation into ${name}.`,
    'The word practised is word, in the sense of meaning. reference_translation is one good translation, not the only one.',
    `Judge on conveying the ${source} sentence and on the practised word, in any form the sentence needs; ignore slips in other words, and small grammar slips that do not touch the practised word. Any other detail of the sentence changed (a number, a person, a tense, an object, a quality) means it is not conveyed.`,
    'Return JSON only, matching the supplied schema, with one field, verdict:',
    '- "right": the answer conveys the sentence and uses the practised word in a form the sentence needs.',
    '- "misspelled": as "right", but the practised word itself has a one-letter or accent slip. A slip in any other word is still "right".',
    '- "other_word": the answer conveys the sentence but uses another word instead of it, one that keeps the meaning. Another word that changes the meaning is "wrong".',
    '- "wrong": the meaning is missed, the answer is not a sentence, or the practised word is left out or used wrongly, including the wrong form.',
  ].join('\n');
  const user = JSON.stringify({
    hebrew_sentence: question.question,
    reference_translation: question.sentence,
    word: context.form,
    lemma: context.lemma,
    part_of_speech: context.partOfSpeech,
    meaning: context.meaning,
    answer,
  });
  return { system, user, schema: LlmTranslationJudgeSchema };
}

const TRANSLATION_VERDICTS: Record<'right' | 'misspelled' | 'other_word' | 'wrong', TypedVerdict> = {
  right: 'exact',
  misspelled: 'near_miss',
  other_word: 'alternative',
  wrong: 'wrong',
};

export function parseTranslationJudge(raw: string): TypedVerdict | null {
  if (raw.trim() === '') return null;
  try {
    const parsed = LlmTranslationJudgeSchema.safeParse(JSON.parse(unfence(raw)));
    return parsed.success ? TRANSLATION_VERDICTS[parsed.data.verdict] : null;
  } catch {
    return null;
  }
}

export function ruleVerdict(question: JudgedQuestion, text: string): TypedVerdict | null {
  switch (question.type) {
    case 'typed_meaning':
      return meaningRuleVerdict(question.meaning, text);
    case 'sentence_translation':
      return translationRuleVerdict(question.sentence, text);
  }
}

export function judgePrompt(question: JudgedQuestion, context: JudgeContext, text: string) {
  switch (question.type) {
    case 'typed_meaning':
      return buildMeaningJudgePrompt(context, text);
    case 'sentence_translation':
      return buildTranslationJudgePrompt(question, context, text);
  }
}

export function parseJudge(type: JudgedQuestion['type'], raw: string): TypedVerdict | null {
  switch (type) {
    case 'typed_meaning':
      return parseMeaningJudge(raw);
    case 'sentence_translation':
      return parseTranslationJudge(raw);
  }
}
