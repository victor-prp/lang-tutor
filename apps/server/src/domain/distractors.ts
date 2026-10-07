import type { LlmDistractors } from '@lang-tutor/core/api';
import { LlmDistractorsSchema } from '@lang-tutor/core/api/schemas';
import type { QuestionType } from '@lang-tutor/core/domain';

import { LANGUAGES, stripStress, type Language, type LanguageCode } from './languages';
import type { SessionPlan } from './plan';
import { dropNulls, unfence } from './translation';

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

/** What the model is asked to do for one item, or null when a type needs
 *  nothing generated: a dictation, a tiles card, and a board word (its board
 *  asks through its first word, tasksFor). */
export function taskFor(type: QuestionType): Task | null {
  switch (type) {
    case 'multiple_choice':
    case 'listen_choice':
      return 'meaning';
    case 'reverse_choice':
      return 'word';
    case 'typed_translation':
    case 'say_translation':
      return 'typed';
    case 'dictation':
    case 'letter_tiles':
    case 'matching':
    case 'read_aloud':
    case 'typed_meaning':
      return null;
  }
}

/** Phase 24. Each position's task. A board's first word asks for wrong
 *  meanings, which its fifth meaning is taken from (spec D10). */
export function tasksFor(plan: SessionPlan): (Task | null)[] {
  return plan.types.map((type, position) => (position === plan.board?.start ? 'meaning' : taskFor(type)));
}

/** A position's key: `q1` is the first card, whichever positions ask nothing. */
export const keyOf = (position: number): string => `q${position + 1}`;

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

/** `context` in session order, `tasks[i]` its position's task. */
export function distractorItems(context: GenerationContext[], tasks: readonly (Task | null)[]): DistractorItem[] {
  return context.flatMap((row, index) => {
    const task = tasks[index];
    return task
      ? [{ key: keyOf(index), task, form: row.form, lemma: row.lemma, partOfSpeech: row.partOfSpeech, translation: row.translation }]
      : [];
  });
}

function language(code: string): Language {
  const found = LANGUAGES[code as LanguageCode];
  if (!found) throw new Error(`no language ${code}`);
  return found;
}

/** A session row that asks the model nothing: a dictation, a tiles card, a
 *  board's later words. */
export type OtherRow = { form: string; translation: string };

export function buildDistractorPrompt(input: {
  items: DistractorItem[];
  from: string;
  to: string;
  others: readonly OtherRow[];
}): DistractorPrompt {
  const learned = language(input.from);
  const answers = language(input.to);
  // Only a row that shares a word or a meaning with an item is one a rule can
  // apply to; with none, the prompt is exactly what it was before they existed.
  const forms = new Set(input.items.map((item) => comparable(item.form)));
  const meanings = new Set(input.items.map((item) => comparable(item.translation)));
  const related = input.others.filter(
    (other) => forms.has(comparable(other.form)) || meanings.has(comparable(other.translation)),
  );
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
    "When several items share a meaning, none of a \"word\" item's wrong answers may be another of those items' words.",
    ...(related.length > 0
      ? [
          'The words under also_in_session are asked elsewhere in the same session and need no answer, but the two rules above apply to them as if they were items.',
        ]
      : []),
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
    ...(related.length > 0
      ? { also_in_session: related.map((other) => ({ word: other.form, correct: other.translation })) }
      : {}),
  });

  return { system, user, schema: LlmDistractorsSchema };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A null list is "none" (structured output's spelling, dropNulls), and a
 *  missing `distractors` is an empty one: a typed item has no wrong options to
 *  give (phase 23, D8). What an empty list costs is the per-task validation's
 *  call, not the parser's. */
function withEmptyLists(json: unknown): unknown {
  const cleaned = dropNulls(json);
  if (!isRecord(cleaned) || !Array.isArray(cleaned.items)) return cleaned;
  return {
    ...cleaned,
    items: cleaned.items.map((item) =>
      isRecord(item) && !('distractors' in item) ? { ...item, distractors: [] } : item,
    ),
  };
}

/** `null` means unreadable; the caller decides what that costs. */
export function parseLlmDistractors(raw: string): LlmDistractors | null {
  let json: unknown;
  try {
    json = JSON.parse(unfence(raw));
  } catch {
    return null;
  }
  const result = LlmDistractorsSchema.safeParse(withEmptyLists(json));
  return result.success ? result.data : null;
}

// What "the same option" means: whitespace collapsed, Hebrew points and
// cantillation gone, stress gone, a trailing sentence mark gone whatever the
// word count, then case. normalizeForm is a dictionary-key function and keeps
// a multi-word expression's punctuation, so it is no help here. Stricter than
// the database's question_options_valid, which compares exact text.
export const comparable = (text: string): string =>
  stripStress(text.replace(/[\u0591-\u05C7]/gu, '').replace(/\s+/g, ' '))
    .replace(/[\s.,;:!?…،؛؟]+$/u, '')
    .trim()
    .toLowerCase();

function badChoice(
  item: DistractorItem,
  items: DistractorItem[],
  others: readonly OtherRow[],
  found: string[],
  explanationLetters: RegExp,
): string | null {
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
  if (item.task === 'word' && texts.some((text) => explanationLetters.test(text))) {
    return `${item.key} offers a wrong answer in the explanation language where the options are ${item.form}'s`;
  }
  // Save-all stores every sense of a word, so the batch can hold the same
  // form twice; the other sense's translation is a right answer on a meaning
  // item. Turned round, two words with one meaning make each other right on a
  // word item.
  const siblings = new Set(
    [...items.filter((other) => other !== item), ...others]
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
 *  bad one is dropped (empty, in the explanation language, the answer itself,
 *  a repeat) and the rest kept, up to MAX_ALTERNATIVES. */
function cleanAlternatives(item: DistractorItem, found: string[] | undefined, explanationLetters: RegExp): string[] {
  const seen = new Set([item.form, item.lemma].map(comparable));
  const kept: string[] = [];
  for (const raw of found ?? []) {
    const text = raw.trim();
    const key = comparable(text);
    if (text === '' || explanationLetters.test(text) || seen.has(key)) continue;
    seen.add(key);
    kept.push(text);
    if (kept.length === MAX_ALTERNATIVES) break;
  }
  return kept;
}

/**
 * All or nothing for the choice tasks: a session is either fully generated or
 * the attempt fails and pg-boss retries it. A typed item cannot fail. Keys the
 * model added beyond the items asked are ignored. `explanation` is the
 * language the meanings are in (the enrollment's source): a reversed card's
 * wrong words and a typed card's alternatives must not be in its script.
 * `others` are the session's rows that ask the model nothing: their other
 * meanings and their words are as off limits as an item's own.
 */
export function validateDistractors(
  items: DistractorItem[],
  answer: LlmDistractors,
  explanation: string,
  others: readonly OtherRow[],
): DistractorVerdict {
  const explanationLetters = language(explanation).letters;
  const answered = new Map(answer.items.map((item) => [item.key, item]));
  const byKey = new Map<string, Generated>();
  for (const item of items) {
    const found = answered.get(item.key);
    if (!found) return { ok: false, reason: `no answer for ${item.key}` };
    if (item.task === 'typed') {
      byKey.set(item.key, {
        distractors: [],
        alternatives: cleanAlternatives(item, found.alternatives, explanationLetters),
      });
      continue;
    }
    const reason = badChoice(item, items, others, found.distractors, explanationLetters);
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

/** Phase 24 (spec D10). A board's five meanings as stored: its four words'
 *  meanings, then the first of the first word's wrong meanings that is none of
 *  them nor another saved meaning of one of its words, so the last pair is
 *  never forced. Null when all three are. */
export function boardMeanings(
  board: readonly GenerationContext[],
  session: readonly GenerationContext[],
  wrong: readonly string[],
): string[] | null {
  const meanings = board.map((row) => row.translation);
  // A board word's other saved meanings would show it twice on the board.
  const boardForms = new Set(board.map((row) => comparable(row.form)));
  const taken = new Set([
    ...meanings.map(comparable),
    ...session.filter((row) => boardForms.has(comparable(row.form))).map((row) => comparable(row.translation)),
  ]);
  const extra = wrong.map((text) => text.trim()).find((text) => !taken.has(comparable(text)));
  return extra === undefined ? null : [...meanings, extra];
}

/** What a position needs beyond the model's answer: a tiles card's tiles, and
 *  a board word's board (its meanings, and which of them is its own). */
export type Extras = { tiles: string[] | null; board: { meanings: string[]; own: number } | null };
export const NO_EXTRAS: Extras = { tiles: null, board: null };
export const NOTHING_GENERATED: Generated = { distractors: [], alternatives: [] };

export type QuestionContent = {
  prompt: string | null;
  options: QuestionOption[] | null;
  alternatives: string[] | null;
  tiles: string[] | null;
};

/**
 * Phase 23 and 24. One generated question's stored content (phase 23 D13,
 * phase 24 D15). Types whose options are Hebrew keep the meaning as their
 * correct option; every other type stores it as the prompt. The prompt is
 * stored, not joined: a question records what was asked.
 */
export function generatedContent(row: GenerationContext, type: QuestionType, generated: Generated, extras: Extras): QuestionContent {
  const none: QuestionContent = { prompt: null, options: null, alternatives: null, tiles: null };
  switch (type) {
    case 'multiple_choice':
    case 'listen_choice':
      return { ...none, options: optionsFor(row.translation, generated.distractors) };
    case 'reverse_choice':
      return { ...none, prompt: row.translation, options: optionsFor(row.form, generated.distractors) };
    case 'typed_translation':
    case 'say_translation':
      return { ...none, prompt: row.translation, alternatives: generated.alternatives };
    case 'dictation':
    case 'read_aloud':
    case 'typed_meaning':
      return { ...none, prompt: row.translation };
    case 'letter_tiles':
      if (!extras.tiles) throw new Error(`the tiles card for ${row.form} has no tiles`);
      return { ...none, prompt: row.translation, tiles: extras.tiles };
    case 'matching': {
      const board = extras.board;
      if (!board) throw new Error(`the board word ${row.form} has no board`);
      return {
        ...none,
        options: board.meanings.map((text, position) => ({ position, text, is_correct: position === board.own })),
      };
    }
  }
}
