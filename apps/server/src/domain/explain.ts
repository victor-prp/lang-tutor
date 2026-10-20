import type { SentenceMistake, SentenceTranslationQuestion } from '@lang-tutor/core/api';
import { LlmSentenceExplainSchema } from '@lang-tutor/core/api/schemas';
import { normaliseTyped } from '@lang-tutor/core/domain';

import type { JudgeContext } from './judge';
import { LANGUAGES } from './languages';
import { unfence } from './translation';

/**
 * Phase 66 (spec D2). The pure half of explaining a translation card's answer:
 * what the model is told, how its answer is read, and the answers no model is
 * needed for. The explanation is information for the learner and grades nothing;
 * services/sessions.ts calls the model and stores what it says.
 */

/** Part of every explain instruction, and what MockServer matches to tell this
 *  call from the judge's. It must not contain JUDGE_MARKER's words. */
export const EXPLAIN_MARKER = "list the mistakes in the learner's sentence";

/** Spec D2: at most this many mistakes are kept, in the model's order. */
export const MAX_MISTAKES = 6;

/** The explainer's thinking budget, in tokens: measured with the explain eval
 *  group. Phase 66b (spec D1): the judged answer now waits on this call beside the
 *  judge's, so more thinking here is a slower grade for every translation. */
export const EXPLAIN_THINKING = 1024;

export type Explanation = { corrected: string; mistakes: SentenceMistake[] };

export function buildExplainPrompt(question: SentenceTranslationQuestion, context: JudgeContext, answer: string) {
  const name = LANGUAGES[context.language].name;
  const source = LANGUAGES[context.explanation].name;
  const system = [
    `Your task: ${EXPLAIN_MARKER}. A ${source}-speaking learner of ${name} was shown a ${source} sentence and typed its translation into ${name}, the answer.`,
    `List what is wrong in the answer as a ${name} translation of hebrew_sentence: grammar (agreement, articles, tense, person, word order), wrong or missing words, a changed meaning, spelling.`,
    `Compare the answer with hebrew_sentence, not with reference_translation, which is one good translation, not the only one. Anything a fluent ${name} speaker would accept as a translation of the sentence is not a mistake: other words that mean the same, another correct word order or form (a short adjective, a contraction), and a word added that only says what the sentence already means (persone after per due, people after for two). Do not list differences from the reference.`,
    'word is the word being practised, in the sense of meaning; treat a mistake in it like any other.',
    'Return JSON only, matching the supplied schema:',
    `- corrected: the answer itself with only its mistakes fixed, in ${name}, keeping the learner's own wording wherever it is correct. The answer unchanged when it has no mistakes.`,
    `- mistakes: one item per mistake, in the order they appear in the answer, at most ${MAX_MISTAKES}. wrong: the words exactly as the answer has them, or "" when something is missing. right: what they should be. why: one short line in ${source}, naming the rule when there is one. An empty list when the answer has no mistakes.`,
  ].join('\n');
  const user = JSON.stringify({
    hebrew_sentence: question.question,
    reference_translation: question.sentence,
    word: context.form,
    meaning: context.meaning,
    answer,
  });
  return { system, user, schema: LlmSentenceExplainSchema };
}

/** The model's explanation, its mistakes capped at MAX_MISTAKES. Null when the
 *  answer is empty or cannot be read. */
export function parseExplain(raw: string): Explanation | null {
  if (raw.trim() === '') return null;
  try {
    const parsed = LlmSentenceExplainSchema.safeParse(JSON.parse(unfence(raw)));
    if (!parsed.success) return null;
    return { corrected: parsed.data.corrected, mistakes: parsed.data.mistakes.slice(0, MAX_MISTAKES) };
  } catch {
    return null;
  }
}

/** Spec D2. An empty answer, or the reference as typed whatever its case or
 *  full stop, has no mistakes and costs no call. Null: only the model can tell. */
export function explainRuleResult(reference: string, text: string): Explanation | null {
  const typed = normaliseTyped(text);
  if (typed === '' || typed === normaliseTyped(reference)) return { corrected: text.trim(), mistakes: [] };
  return null;
}

/** Phase 66b (spec D1, final review M1). Whether a text holds a sentence to
 *  check: one empty, or of spaces and punctuation alone, holds none, so it is
 *  never called a right sentence. */
export function hasSentence(text: string): boolean {
  return normaliseTyped(text) !== '';
}
