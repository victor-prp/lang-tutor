import type { ClozeTypedQuestion, SentenceTranslationQuestion, TypedVerdict } from '@lang-tutor/core/api';
import { LlmFitJudgeSchema, LlmMeaningJudgeSchema, LlmTranslationJudgeSchema } from '@lang-tutor/core/api/schemas';
import { normaliseHebrew, normaliseTyped, wordOnly, type JudgedQuestion } from '@lang-tutor/core/domain';

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
 *  example pins. The example is absent for a saved sense without one. Phase 34
 *  (spec D7): `example` and `exampleTranslation` are the sentence the card
 *  showed and its hidden other half (findJudgeContext), so the judge sees what the
 *  learner saw; the saved example only when the card fell back on it. */
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
  /** Phase 31 (spec D13). The rendering's other words, the gloss's key and the
   *  gloss's other words: right as typed, so רכב for מכונית, or אצבע on a card
   *  asking `fingers`, costs no judge call. */
  alternatives?: readonly string[];
};

/** Spec D3 step 2. Empty text is "show me the answer"; the stored meaning, or
 *  (phase 31, D13) one of its stored alternatives, is right as typed. Null: only
 *  the model can tell. */
export function meaningRuleVerdict(meaning: string, text: string, alternatives: readonly string[] = []): TypedVerdict | null {
  const typed = normaliseHebrew(text);
  if (typed === '') return 'wrong';
  if (typed === normaliseHebrew(meaning)) return 'exact';
  return alternatives.some((alternative) => normaliseHebrew(alternative) === typed) ? 'exact' : null;
}

export function buildMeaningJudgePrompt(context: MeaningJudgeContext, answer: string) {
  const name = LANGUAGES[context.language].name;
  const source = LANGUAGES[context.explanation].name;
  const system = [
    `Your task: ${JUDGE_MARKER}. A ${source}-speaking learner of ${name} was shown a ${name} word and typed its meaning in ${source}.`,
    'The meaning practised is saved_meaning, in the sense the example shows.',
    'Return JSON only, matching the supplied schema, with one field, verdict:',
    '- "right": the answer means the same as saved_meaning in this sense. Accept a synonym, another form, tense or person of it (for example לדבר, מדבר, דיבר), with or without a prefix such as ה, ל, ו or ש, with or without niqqud, and with small Hebrew spelling slips.',
    '- "other_sense": the answer is a meaning the word really has in another context, one a dictionary would list as a sense of its own, but not the sense practised (for example, for "bank" practised as בנק: גדת נהר, a river bank).',
    '- "wrong": anything else, including the meaning of another word, an answer too general, and one only related, associated or near in meaning, however close (for example, for "imagination" practised as דמיון: הזייה, a hallucination, or יצירתיות, creativity).',
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
 *  is right as typed, whatever its case or full stop; one word for a longer
 *  sentence is wrong, as the model judged it (the app asks for the whole
 *  sentence instead of sending it). Null: only the model can tell. */
export function translationRuleVerdict(reference: string, text: string): TypedVerdict | null {
  const typed = normaliseTyped(text);
  if (typed === '' || wordOnly(typed, reference)) return 'wrong';
  return typed === normaliseTyped(reference) ? 'exact' : null;
}

/** Phase 45 (spec D3). The translation judge's thinking budget, in tokens. With
 *  none it took "talk with everyone" for "communicate clearly with everyone";
 *  512 judged it wrong every time, at about 2.4 s a call. */
export const TRANSLATION_JUDGE_THINKING = 512;

/** Phase 66 (spec D1). Grades the practised word alone: mistakes elsewhere in the
 *  sentence are domain/explain.ts's to show, and cost nothing. */
export function buildTranslationJudgePrompt(question: SentenceTranslationQuestion, context: JudgeContext, answer: string) {
  const name = LANGUAGES[context.language].name;
  const source = LANGUAGES[context.explanation].name;
  const system = [
    `Your task: ${JUDGE_MARKER}. A ${source}-speaking learner of ${name} was shown a ${source} sentence and typed its translation into ${name}.`,
    'The word practised is word, in the sense of meaning. reference_translation is one good translation, not the only one.',
    `Judge the practised word alone: whether the answer uses it, in this sense and in a form the ${source} sentence needs (its tense, person, number or gender). ignore everything else in the answer: mistakes in other words, their grammar, and details changed or missing elsewhere in the sentence are not judged here.`,
    'Return JSON only, matching the supplied schema, with one field, verdict:',
    '- "right": the answer uses the practised word, in this sense, in a form the sentence needs.',
    '- "misspelled": as "right", but the practised word itself has a one-letter or accent slip. A slip in any other word is still "right".',
    `- "other_word": the practised word is not used, but another word stands in the practised word's place and means the same there. Another word that does not mean the same is "wrong".`,
    '- "wrong": the practised word is missing, used in another sense or used wrongly, including the wrong form; or the answer is not a sentence (the word alone, or a word or two) or not an attempt at this sentence.',
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

export function ruleVerdict(question: JudgedQuestion, text: string, alternatives: readonly string[] = []): TypedVerdict | null {
  switch (question.type) {
    case 'typed_meaning':
      return meaningRuleVerdict(question.meaning, text, alternatives);
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

/**
 * Phase 41 (spec D2). Whether a word the card's list missed fills a typed
 * cloze's gap. The learner saw the sentence with its gap and no translation, so
 * the model sees the same: whether the answer makes it a correct, natural
 * sentence, whatever it then means. A word in a form the gap cannot take does
 * not fit. Only `fits` and `wrong`: a slip of the word meant is the rule's
 * `near_miss`, decided before any call.
 */
export function buildFitJudgePrompt(question: ClozeTypedQuestion, language: LanguageCode, answer: string) {
  const name = LANGUAGES[language].name;
  const system = [
    `Your task: ${JUDGE_MARKER}. A learner of ${name} was shown a ${name} sentence with one word left out, marked ___, and no translation, and typed a word for the gap.`,
    'word_meant is the word the sentence was written with; the answer is another word.',
    'Put the answer in the gap and read the sentence on its own.',
    'Return JSON only, matching the supplied schema, with one field, verdict:',
    '- "fits": the sentence is correct and natural with the answer, whatever it then means, and the answer is in the form the gap needs, agreeing with the words around it.',
    '- "wrong": anything else, including a sentence that is ungrammatical, unnatural or meaningless with the answer, or an answer in a form the gap cannot take.',
  ].join('\n');
  const sentence = `${question.sentence.slice(0, question.gap.start)}___${question.sentence.slice(question.gap.end)}`;
  const user = JSON.stringify({ sentence, word_meant: question.answer, answer });
  return { system, user, schema: LlmFitJudgeSchema };
}

/** The model's fit verdict, or null when it cannot be read. */
export function parseFitJudge(raw: string): 'fits' | 'wrong' | null {
  if (raw.trim() === '') return null;
  try {
    const parsed = LlmFitJudgeSchema.safeParse(JSON.parse(unfence(raw)));
    return parsed.success ? parsed.data.verdict : null;
  } catch {
    return null;
  }
}
