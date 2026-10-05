import type { LlmDistractors } from '@lang-tutor/core/api';
import { LlmDistractorsSchema } from '@lang-tutor/core/api/schemas';

import { LANGUAGES, stripStress, type Language, type LanguageCode } from './languages';
import { unfence } from './translation';

/**
 * Phase 19. The pure core of a list session's generation: what to ask the
 * model for wrong options, and whether its answer is usable. No I/O, no clock,
 * no randomness (ADR 0001 R3). services/sessions.ts calls the model and
 * decides what a refusal costs.
 */

/** Part of the system prompt, and what MockServer matches to tell this call
 *  from a translation. Changing the wording means changing the stubs. */
export const DISTRACTOR_MARKER = 'three wrong answers';

/** One picked sense as the generation reads it: the saved form, its lexeme,
 *  and that form's rendering of the sense in the enrollment's source language. */
export type GenerationContext = {
  senseId: string;
  variantId: string;
  lexemeId: string;
  form: string;
  lemma: string;
  partOfSpeech: string;
  translation: string;
};

export type DistractorItem = {
  key: string;
  form: string;
  lemma: string;
  partOfSpeech: string;
  translation: string;
};

/** Structurally LlmJsonRequest; services/sessions.ts is where the two meet,
 *  as with TranslationPrompt. */
export type DistractorPrompt = {
  system: string;
  user: string;
  schema: typeof LlmDistractorsSchema;
};

export type DistractorVerdict =
  | { ok: true; byKey: Map<string, string[]> }
  | { ok: false; reason: string };

export function distractorItems(context: GenerationContext[]): DistractorItem[] {
  return context.map((row, index) => ({
    key: `q${index + 1}`,
    form: row.form,
    lemma: row.lemma,
    partOfSpeech: row.partOfSpeech,
    translation: row.translation,
  }));
}

function language(code: string): Language {
  const found = LANGUAGES[code as LanguageCode];
  if (!found) throw new Error(`no language ${code}`);
  return found;
}

export function buildDistractorPrompt(input: {
  items: DistractorItem[];
  from: string;
  to: string;
}): DistractorPrompt {
  const learned = language(input.from);
  const answers = language(input.to);
  const system = [
    `You write multiple-choice options for a ${learned.name} vocabulary quiz for a Hebrew-speaking learner.`,
    'Return JSON only, matching the supplied schema.',
    `Each item is a ${learned.name} word or phrase and its correct ${answers.name} translation.`,
    `For each item write ${DISTRACTOR_MARKER} in ${answers.name}.`,
    'Each wrong answer must be plausible: the same part of speech, the same register and a',
    'similar length as the correct translation.',
    'A wrong answer must never be right: not the translation itself, not a synonym of it, and',
    'not another valid translation of the word.',
    'The three wrong answers of an item must differ from each other.',
    'When several items share a word, none of an item\'s wrong answers may be another item\'s correct answer.',
    'Answer every item, using its key exactly as given.',
    ...answers.writing,
  ].join('\n');

  const user = JSON.stringify({
    items: input.items.map((item) => ({
      key: item.key,
      word: item.form,
      lemma: item.lemma,
      part_of_speech: item.partOfSpeech,
      correct: item.translation,
    })),
  });

  return { system, user, schema: LlmDistractorsSchema };
}

/** `null` means unreadable; the caller decides what that costs. */
export function parseLlmDistractors(raw: string): LlmDistractors | null {
  let json: unknown;
  try {
    json = JSON.parse(unfence(raw));
  } catch {
    return null;
  }
  const result = LlmDistractorsSchema.safeParse(json);
  return result.success ? result.data : null;
}

// What "the same option" means: whitespace collapsed, Hebrew points and
// cantillation gone, stress gone, a trailing sentence mark gone whatever the
// word count, then case. normalizeForm is a dictionary-key function and keeps
// a multi-word expression's punctuation, so it is no help here. Stricter than
// the database's question_options_valid, which compares exact text.
const comparable = (text: string): string =>
  stripStress(text.replace(/[\u0591-\u05C7]/gu, '').replace(/\s+/g, ' '))
    .replace(/[\s.,;:!?…،؛؟]+$/u, '')
    .trim()
    .toLowerCase();

/**
 * All or nothing: a session is either fully generated or the attempt fails and
 * pg-boss retries it. Keys the model added beyond the items asked are ignored.
 */
export function validateDistractors(items: DistractorItem[], answer: LlmDistractors): DistractorVerdict {
  const answered = new Map(answer.items.map((item) => [item.key, item.distractors]));
  const byKey = new Map<string, string[]>();
  for (const item of items) {
    const found = answered.get(item.key);
    if (!found) return { ok: false, reason: `no answer for ${item.key}` };
    const texts = found.map((text) => text.trim());
    if (texts.length !== 3 || texts.some((text) => text === '')) {
      return { ok: false, reason: `${item.key} needs three non-empty wrong answers` };
    }
    const all = [item.translation, ...texts].map(comparable);
    if (new Set(all).size !== all.length) {
      return { ok: false, reason: `${item.key} repeats the answer or another wrong answer` };
    }
    // Save-all stores every sense of a word, so the batch can hold the same
    // form twice; the other sense's translation is a right answer here.
    const siblings = new Set(
      items
        .filter((other) => other !== item && comparable(other.form) === comparable(item.form))
        .map((other) => comparable(other.translation)),
    );
    if (all.slice(1).some((text) => siblings.has(text))) {
      return { ok: false, reason: `${item.key} offers another meaning of the same word as a wrong answer` };
    }
    byKey.set(item.key, texts);
  }
  return { ok: true, byKey };
}

/** A generated question's options as stored: correct first. The shown order is
 *  shuffled per session by pickQuestions, exactly as for seed questions. */
export function optionsFor(
  translation: string,
  distractors: string[],
): { position: number; text: string; is_correct: boolean }[] {
  return [translation, ...distractors].map((text, position) => ({
    position,
    text,
    is_correct: position === 0,
  }));
}
