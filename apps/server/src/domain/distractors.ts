import type { LlmDistractors } from '@lang-tutor/core/api';
import { LlmDistractorsSchema } from '@lang-tutor/core/api/schemas';
import type { QuestionType } from '@lang-tutor/core/domain';

import { LANGUAGES, stripStress, type Language, type LanguageCode } from './languages';
import { unfence } from './translation';

/**
 * Phase 19. The pure core of a list session's generation: what to ask the
 * model for wrong options, and whether its answer is usable. No I/O, no clock,
 * no randomness (ADR 0001 R3). services/sessions.ts calls the model and
 * decides what a refusal costs.
 *
 * Phase 23. One call serves three tasks (spec D8): wrong meanings for today's
 * card, wrong target words for the reversed card, and the other right answers
 * a typed card should accept.
 */

/** What the model is asked to do for one item. */
export type Task = 'meaning' | 'word' | 'typed';

export function taskFor(type: QuestionType): Task {
  switch (type) {
    case 'multiple_choice':
      return 'meaning';
    case 'reverse_choice':
      return 'word';
    case 'typed_translation':
      return 'typed';
  }
}

/** The most alternatives a typed question keeps (questions_shape_valid). */
export const MAX_ALTERNATIVES = 5;

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
  task: Task;
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

/** What one item came back with, validated: three wrong options for a choice
 *  task, cleaned alternatives for a typed one, and nothing else. */
export type Generated = { distractors: string[]; alternatives: string[] };

export type DistractorVerdict =
  | { ok: true; byKey: Map<string, Generated> }
  | { ok: false; reason: string };

/** `types[i]` is the type the service chose for `context[i]`. */
export function distractorItems(context: GenerationContext[], types: readonly QuestionType[]): DistractorItem[] {
  return context.map((row, index) => ({
    key: `q${index + 1}`,
    task: taskFor(types[index]),
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
    `You write the answers for a ${learned.name} vocabulary quiz for a Hebrew-speaking learner.`,
    'Return JSON only, matching the supplied schema.',
    `Each item is a ${learned.name} word or phrase with its lemma and part of speech, its correct ${answers.name} translation, and a task:`,
    `- "meaning": the learner sees the ${learned.name} word and picks its ${answers.name} translation. Write ${DISTRACTOR_MARKER} in ${answers.name} as distractors.`,
    `- "word": the learner sees the ${answers.name} translation and picks the ${learned.name} word. Write ${DISTRACTOR_MARKER} in ${learned.name} as distractors.`,
    `- "typed": the learner sees the ${answers.name} translation and types the ${learned.name} word. Leave distractors empty. As alternatives, list every other ${learned.name} word or phrase that translates it equally well in this sense, at most ${MAX_ALTERNATIVES}, or none.`,
    'Each wrong answer must be plausible: the same part of speech, the same register and a',
    'similar length as the correct answer.',
    'A wrong answer must never be right: not the correct answer itself, not a synonym of it, and',
    'not another valid translation of the word.',
    'The three wrong answers of an item must differ from each other.',
    "When several items share a word, none of an item's wrong answers may be another item's correct answer.",
    'Answer every item, using its key exactly as given.',
    ...answers.writing,
    ...learned.writing,
  ].join('\n');

  const user = JSON.stringify({
    items: input.items.map((item) => ({
      key: item.key,
      task: item.task,
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

const HEBREW = /\p{Script=Hebrew}/u;

function badChoice(item: DistractorItem, items: DistractorItem[], found: string[]): string | null {
  const texts = found.map((text) => text.trim());
  if (texts.length !== 3 || texts.some((text) => text === '')) {
    return `${item.key} needs three non-empty wrong answers`;
  }
  // A word item's right answer is the form, and its lemma is right too.
  const rights = item.task === 'word' ? [item.form, item.lemma] : [item.translation];
  const all = texts.map(comparable);
  if (new Set(all).size !== all.length || all.some((text) => rights.map(comparable).includes(text))) {
    return `${item.key} repeats the answer or another wrong answer`;
  }
  if (item.task === 'word' && texts.some((text) => HEBREW.test(text))) {
    return `${item.key} offers a Hebrew wrong answer where the options are ${item.form}'s language`;
  }
  // Save-all stores every sense of a word, so the batch can hold the same
  // form twice; the other sense's translation is a right answer on a meaning
  // item. Turned round, two words with one meaning make each other right on a
  // word item.
  const siblings = new Set(
    items
      .filter((other) => other !== item)
      .filter((other) =>
        item.task === 'word'
          ? comparable(other.translation) === comparable(item.translation)
          : comparable(other.form) === comparable(item.form),
      )
      .map((other) => comparable(item.task === 'word' ? other.form : other.translation)),
  );
  if (all.some((text) => siblings.has(text))) {
    return item.task === 'word'
      ? `${item.key} offers another saved word with the same meaning as a wrong answer`
      : `${item.key} offers another meaning of the same word as a wrong answer`;
  }
  return null;
}

/** Never a refusal: alternatives only widen what a typed card accepts, so a
 *  bad one is dropped (empty, Hebrew, the answer itself, a repeat) and the
 *  rest kept, up to MAX_ALTERNATIVES. */
function cleanAlternatives(item: DistractorItem, found: string[] | undefined): string[] {
  const seen = new Set([item.form, item.lemma].map(comparable));
  const kept: string[] = [];
  for (const raw of found ?? []) {
    const text = raw.trim();
    const key = comparable(text);
    if (text === '' || HEBREW.test(text) || seen.has(key)) continue;
    seen.add(key);
    kept.push(text);
    if (kept.length === MAX_ALTERNATIVES) break;
  }
  return kept;
}

/**
 * All or nothing for the choice tasks: a session is either fully generated or
 * the attempt fails and pg-boss retries it. A typed item cannot fail. Keys the
 * model added beyond the items asked are ignored.
 */
export function validateDistractors(items: DistractorItem[], answer: LlmDistractors): DistractorVerdict {
  const answered = new Map(answer.items.map((item) => [item.key, item]));
  const byKey = new Map<string, Generated>();
  for (const item of items) {
    const found = answered.get(item.key);
    if (!found) return { ok: false, reason: `no answer for ${item.key}` };
    if (item.task === 'typed') {
      byKey.set(item.key, { distractors: [], alternatives: cleanAlternatives(item, found.alternatives) });
      continue;
    }
    const reason = badChoice(item, items, found.distractors);
    if (reason) return { ok: false, reason };
    byKey.set(item.key, { distractors: found.distractors.map((text) => text.trim()), alternatives: [] });
  }
  return { ok: true, byKey };
}

/** A generated question's options as stored: correct first. The shown order is
 *  shuffled per session by pickQuestions, exactly as for seed questions. */
export function optionsFor(correct: string, distractors: string[]): QuestionOption[] {
  return [correct, ...distractors].map((text, position) => ({
    position,
    text,
    is_correct: position === 0,
  }));
}

/** Structurally db/schema's QuestionOption: stored data, snake_case. */
export type QuestionOption = { position: number; text: string; is_correct: boolean };

/**
 * Phase 23. One generated question's stored content (spec D13). Today's card
 * asks the form and offers meanings; the reversed card asks the meaning and
 * offers words; the typed card asks the meaning and keeps the alternatives.
 * The Hebrew prompt is stored, not joined: a question records what was asked.
 */
export function generatedContent(
  row: GenerationContext,
  type: QuestionType,
  generated: Generated,
): { prompt: string | null; options: QuestionOption[] | null; alternatives: string[] | null } {
  switch (type) {
    case 'multiple_choice':
      return { prompt: null, options: optionsFor(row.translation, generated.distractors), alternatives: null };
    case 'reverse_choice':
      return { prompt: row.translation, options: optionsFor(row.form, generated.distractors), alternatives: null };
    case 'typed_translation':
      return { prompt: row.translation, options: null, alternatives: generated.alternatives };
  }
}
