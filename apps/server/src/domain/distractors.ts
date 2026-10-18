import type { LlmDistractors } from '@lang-tutor/core/api';
import { LlmDistractorsSchema } from '@lang-tutor/core/api/schemas';
import type { QuestionType } from '@lang-tutor/core/domain';

import { findGap } from './cloze';
import { LANGUAGES, stripStress, type Language, type LanguageCode } from './languages';
import type { SessionPlan } from './plan';
import {
  MAX_ALTERNATIVES,
  MAX_AVOID,
  MAX_GAP_ALTERNATIVES,
  SENTENCE_MIN_WORDS,
  SHORT_SENTENCE_MAX_WORDS,
  SHORT_SENTENCE_MIN_ASKED,
  TRANSLATE_MAX_WORDS,
  validateSentenceItem,
  validateTranslateItem,
  type SentenceContent,
  type TranslateContent,
} from './sentences';
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
 *
 * Phase 27. Three tasks more (spec D5 to D7): wrong words for a sentence with
 * a blank, a new sentence with its blank, and a Hebrew sentence to translate.
 *
 * Phase 34 (spec D3, D4). A choice item asks for six wrong options and keeps the
 * first three that are not known to be right; the rest are spares the checker
 * (domain/check.ts) draws on when it calls one of the three right.
 */

/** What the model is asked to do for one item. */
export type Task = 'meaning' | 'word' | 'typed' | 'gap' | 'sentence' | 'translate';

/** Phase 39 (spec D6). A new_meaning is generated as a multiple choice: the
 *  prepare job maps its type (services/sessions.ts, generatedAs) before any
 *  generation step sees it, so a caller that skipped the mapping fails loudly
 *  instead of generating a card unlike the multiple choice it is. */
const refuseNewMeaning = (): never => {
  throw new Error('a new_meaning is generated as a multiple choice: map its type first');
};

/** What the model is asked to do for one item, or null when a type needs
 *  nothing generated: a dictation, a tiles card, and a board word (its board
 *  asks through its first word, tasksFor). */
export function taskFor(type: QuestionType): Task | null {
  switch (type) {
    case 'new_meaning':
      return refuseNewMeaning();
    case 'multiple_choice':
    case 'listen_choice':
      return 'meaning';
    case 'reverse_choice':
      return 'word';
    case 'typed_translation':
    case 'say_translation':
      return 'typed';
    case 'cloze_choice':
      return 'gap';
    case 'cloze_typed':
      return 'sentence';
    case 'sentence_translation':
      return 'translate';
    case 'dictation':
    case 'letter_tiles':
    case 'matching':
    case 'read_aloud':
    case 'typed_meaning':
    case 'meet':
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

/** The most alternatives the typed task asks for. */
export { MAX_ALTERNATIVES };

/** Phase 34 (spec D1). The most alternatives a stored question keeps
 *  (questions_shape_valid, raised from five): the rendering's stored list, a
 *  session's own and the siblings, which the model's five no longer have to cover. */
export const MAX_CARD_ALTERNATIVES = 10;

/** Part of the system prompt, and what MockServer matches to tell this call
 *  from a translation. Changing the wording means changing the stubs. */
export const DISTRACTOR_MARKER = 'six wrong answers';

/** Phase 34 (spec D4). How many wrong options a choice card shows, and how many
 *  of the six asked must survive D3 and the checker for the card to stand; with
 *  fewer, the card is refused (phase 48, spec D1, D2), not the batch. */
export const KEPT_DISTRACTORS = 3;

/** Phase 34 (spec D4, D5). How many wrong options a choice item asks for, and the
 *  most it keeps, spares included: the checker numbers every one it is sent, and a
 *  miscount leaves that card unjudged, which the checker refuses (phase 48, spec
 *  D2, ruling R3), so a longer list from the model is cut here. */
export const ASKED_DISTRACTORS = 6;

/**
 * Phase 34 (spec D3). What the dictionary already knows to be right, read once
 * per batch (repo/dictionary.ts, findKnownRight) so no wrong option is one of
 * them:
 * - `meaningsByLexeme`: per picked lexeme, every rendering, citation form and
 *   alternative of every sense, and every gloss key and gloss alternative, in the
 *   learner language, of the lexeme and of each homograph (another lexeme of the
 *   language with a form spelled like a picked one: `see`'s `saw` beside `saw`);
 * - `meaningsByGloss`: per picked gloss, its own meanings only (its key, its
 *   alternatives, its senses' renderings), which a context sentence's reading
 *   must be one of (spec D5);
 * - `wordsByPrompt`: per rendering text a superset of the picked renderings
 *   (the read compares loosely), every target word right for it: the accepted
 *   answers of each rendering with that text in the language pair, and the form
 *   and lemma it renders. `knownWords` applies the exact rule, `comparable`.
 */
export type KnownRight = {
  meaningsByLexeme: Map<string, string[]>;
  meaningsByGloss: Map<string, string[]>;
  wordsByPrompt: Map<string, string[]>;
};

/** Nothing known: a batch with no dictionary behind it (the eval's). */
export const nothingKnown = (): KnownRight => ({ meaningsByLexeme: new Map(), meaningsByGloss: new Map(), wordsByPrompt: new Map() });

/** Spec D3 (1, 2). The meanings known right for a lexeme's word, its homographs' included. */
export const knownMeanings = (known: KnownRight, lexemeId: string): string[] => known.meaningsByLexeme.get(lexemeId) ?? [];

/** Spec D3 (3). The target words known right for a Hebrew prompt: same text under `comparable`. */
export function knownWords(known: KnownRight, prompt: string): string[] {
  const key = comparable(prompt);
  return [...known.wordsByPrompt].flatMap(([text, words]) => (comparable(text) === key ? words : []));
}

/** One picked gloss as the generation reads it: the saved form, its lexeme,
 *  and that form's rendering of one member sense in the enrollment's source
 *  language. */
export type GenerationContext = {
  /** Phase 31. The gloss the card practises; senseId and variantId name the rendering it is built from. */
  glossId: string;
  senseId: string;
  variantId: string;
  lexemeId: string;
  form: string;
  lemma: string;
  partOfSpeech: string;
  translation: string;
  /** Phase 27 (spec D7). The learner's saved example for this form and sense,
   *  and its Hebrew translation: null when they saved none. */
  example: string | null;
  exampleTranslation: string | null;
  /** Phase 34 (spec D1, D2). What the accept job stored for this rendering: every
   *  right answer, the form that agrees with it (null = the form), and when the job
   *  ran (null = never, and the session asks for it). prepareSession replaces
   *  `answerForm` with usableAnswerForm's answer before anything else reads the
   *  row, so past that point it is the form a card asks for, or null. */
  acceptedAnswers: string[];
  answerForm: string | null;
  acceptedAt: Date | null;
};

/** Phase 27 (spec D5, D6). Per gloss (phase 31), the sentences its last
 *  sessions asked, newest first, so a new one is never last time's. Read by
 *  the service. */
export type RecentSentences = Map<string /* glossId */, { cloze: string[]; translate: string[] }>;

export type DistractorItem = {
  key: string;
  task: Task;
  /** Phase 34 (spec D3). Whose known-right meanings a meaning item's options must avoid. */
  lexemeId: string;
  form: string;
  lemma: string;
  partOfSpeech: string;
  translation: string;
  example: string | null;
  exampleTranslation: string | null;
  /** Phase 34 (spec D2). The form a card of this row asks for when it is not
   *  `form`; never sent to the model, only kept out of a word item's wrong options. */
  answerForm: string | null;
  /** Sentences the model must not write again (spec D5, D6); empty for other tasks. */
  avoid: string[];
  /** A gap item's blanked text in `example` (spec D7); null for every other task. */
  blank: string | null;
  /** Phase 62c (spec D3). Set only on a gap item asked again: what its last sentence got wrong. */
  rewrite?: GapRewrite;
};

/** Phase 62c (spec D3). Why a gap item is asked again: its last sentence, if it wrote one,
 *  and the wrong answers the checker found it fits, or why validation refused it. */
export type GapRewrite = { sentence: string | null; fits: string[]; problem: string | null };

/** Phase 62c. A phrase of the rewrite's rule, which a prompt carries only when an item is a rewrite. */
export const REWRITE_MARKER = 'its last sentence';

/** Structurally LlmJsonRequest; services/sessions.ts is where the two meet,
 *  as with TranslationPrompt. */
export type DistractorPrompt = {
  system: string;
  user: string;
  schema: typeof LlmDistractorsSchema;
};

/** What one item came back with, validated: three wrong options for a choice
 *  task, cleaned alternatives for a typed one, and nothing else. */
export type Generated = {
  distractors: string[];
  /** Phase 34 (spec D4). A choice item's other usable wrong options, in the
   *  model's order: what the checker's drops are refilled from. */
  spares: string[];
  alternatives: string[];
  /** Phase 27 (spec D5, D6). A sentence item's validated content, or why it
   *  was not usable: `degraded` is set exactly when `sentence` and `translate`
   *  are both null for a sentence or translate item, and null otherwise. */
  sentence: SentenceContent | null;
  translate: TranslateContent | null;
  degraded: string | null;
};

/** Phase 48 (spec D1). Every item's content, and why each refused item was refused. A refused item has no byKey entry. */
export type DistractorVerdict = { byKey: Map<string, Generated>; refused: Map<string, string> };

/** Spec D5, D6: the sentences an item must not repeat. A gap sentence avoids
 *  the saved example (the model is shown it) and the last sessions' sentences;
 *  a translation avoids the last sessions' Hebrew sentences and the saved
 *  example's Hebrew, so the example is not written back as the sentence. */
function avoidFor(row: GenerationContext, task: Task, recent: RecentSentences): string[] {
  const seen = recent.get(row.glossId);
  // Phase 62 (spec D1): a gap item writes its sentence as a sentence item does.
  if (task === 'sentence' || task === 'gap') {
    return [...(row.example ? [row.example] : []), ...(seen?.cloze ?? []).slice(0, MAX_AVOID)];
  }
  if (task === 'translate') {
    return [...(row.exampleTranslation ? [row.exampleTranslation] : []), ...(seen?.translate ?? []).slice(0, MAX_AVOID)];
  }
  return [];
}

/** `context` in session order, `tasks[i]` its position's task. */
export function distractorItems(
  context: GenerationContext[],
  tasks: readonly (Task | null)[],
  recent: RecentSentences,
): DistractorItem[] {
  return context.flatMap((row, index) => {
    const task = tasks[index];
    if (!task) return [];
    // Spec D7: the blank is the example's own text for the form, as its card shows it.
    const where = task === 'gap' && row.example ? findGap(row.example, [row.form, row.lemma]) : null;
    return [
      {
        key: keyOf(index),
        task,
        lexemeId: row.lexemeId,
        form: row.form,
        lemma: row.lemma,
        partOfSpeech: row.partOfSpeech,
        translation: row.translation,
        example: row.example,
        exampleTranslation: row.exampleTranslation,
        answerForm: row.answerForm,
        avoid: avoidFor(row, task, recent),
        blank: where && row.example ? row.example.slice(where.start, where.end) : null,
      },
    ];
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

/** Phase 59 (spec D1). A practised word of the learner's list, as the prompts
 *  name it: `key` (w1, w2, …) is how the context call's word map points back at it. */
export type LearnerWord = { key: string; glossId: string; word: string; meaning: string };

/** Phase 59 (spec D1). The learner's words as a prompt's user JSON carries them. */
export const learnerWordsJson = (words: readonly LearnerWord[]) =>
  words.map(({ key, word, meaning }) => ({ key, word, meaning }));

export function buildDistractorPrompt(input: {
  items: DistractorItem[];
  from: string;
  to: string;
  others: readonly OtherRow[];
  /** Phase 59 (spec D1): sent only when an item writes a sentence (phase 62: a gap or sentence item too). */
  learnerWords?: readonly LearnerWord[];
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
    `- "gap": the learner sees a sentence with the ${learned.name} word blanked, and picks the missing word. Write a new sentence exactly as a "sentence" item does, following every rule of that task, in sentence, gap and translation, and leave alternatives empty; write it so that the words around the gap rule out most other words of its part of speech, with an object, a place or a time few words go with, as "Lei parla tre lingue." does for parla: one cannot sing or sleep three languages; ruling out the wrong words comes before the learner's words. Write the word itself in sentence, never a blank. Then write ${DISTRACTOR_MARKER} in ${learned.name} for its gap: words of the same part of speech and in the same form as the word in gap, but from a different field of meaning, each of which makes your sentence wrong or meaningless, so that a learner who reads the sentence alone can rule it out. Read each candidate into the sentence and drop it if the sentence still makes sense, however differently: never a word that also fits. In a sentence where many words make sense in the blank (anything one puts in a drink, any adjective for a city), none of those words may be a wrong answer of this item: its wrong answers clash with the other words of the sentence (an object, subject, place or time they cannot go with).`,
    `- "sentence": write a new, natural, everyday ${learned.name} sentence of ${SHORT_SENTENCE_MIN_ASKED} to ${SHORT_SENTENCE_MAX_WORDS} words that uses the word in the meaning given by correct and shown by the example, never in another sense. Use whatever form of the word the sentence needs, written as consecutive words, as many as the word has. Write it so that its other words point to the word: someone reading it without its translation and without the word should guess that word, or one of the same meaning; never a sentence that many different words would complete, such as "Please ___ the file." Short is not enough: "The ___ is green." or "Where is my ___?" points to nothing, while "I bought a ___ for my balcony." points to plant: give it the phrase that makes the word the likeliest guess (what it does, where it is, what goes with it), within the limit. When learner_words is given, the learner knows only those ${learned.name} words and the word itself: build the sentence from the word and learner_words, in whatever form each needs, adding another word only where the sentence cannot stand, or cannot point to the word, without it, and then a simple one (a pronoun, an article, a preposition, or the verb to be or to have); pointing to the word comes first, then a short sentence, then the learner's words. learner_words limits the sentence only: alternatives are every word that fits the gap, whether the learner knows it or not. Count its words: never more than ${SHORT_SENTENCE_MAX_WORDS}. It must differ from every sentence in avoid. Put it in sentence; the word exactly as written in the sentence in gap; the whole sentence in natural ${answers.name}, which fixes its person, number and tense, in translation; and in alternatives every other ${learned.name} word that would fill the gap with the sentence read on its own, without its translation, leaving a correct and natural sentence whatever it then means, not only words of the same meaning, in the form the gap needs, agreeing in gender, number and case with the words around it, the likeliest first, at most ${MAX_GAP_ALTERNATIVES}, or none. Leave distractors empty.`,
    `- "translate": write a short, natural, everyday ${answers.name} sentence of ${SENTENCE_MIN_WORDS} to ${TRANSLATE_MAX_WORDS} words that uses the meaning in correct, in the sense the example shows. It must differ from every sentence in avoid. Put it in sentence; a natural ${learned.name} translation of it that uses the word, in whatever form the translation needs, in translation; and that word exactly as written in the translation in gap. Leave distractors empty. Count the words of a translate item's sentence: never more than ${TRANSLATE_MAX_WORDS} (this limit is the translate task's alone). When learner_words is given, the learner knows only those ${learned.name} words and the word itself: write the ${learned.name} translation first, from the word and learner_words alone, in whatever form each needs, adding another word only where the sentence cannot stand without it, and then a simple one (a pronoun, an article, a preposition, or the verb to be or to have); then write sentence as its ${answers.name} translation.`,
    // Phase 62c (spec D3): only a call that asks a gap item again carries its rule, so the
    // session's own batch prompt is exactly what it was.
    ...(input.items.some((item) => item.rewrite)
      ? [
          `- An item with rewrite is a "gap" item written before, and ${REWRITE_MARKER} (rewrite.old_sentence) could not be used: the words in rewrite.fits made it correct as wrong answers, or rewrite.problem says why it was refused. Write a new sentence for its word around another verb or phrase, never the last sentence with a word changed or added: the words next to the gap must be ones that only the word's kind goes with, so that its wrong answers cannot. For a person, a verb only people do (speaks, works, studies), and things as the wrong answers (a table, a book, a wall), never animals or people; for a thing, what only that kind of thing does or has done to it; for an adjective, a noun its wrong answers cannot describe at all, not even figuratively (a carbonated or a paved man); for a verb, an object only it takes. Then keep the learner's words: count them, and at least half of the sentence's other words of three letters or more come from learner_words wherever it still points with them; a word outside learner_words, of any kind, is added only where pointing needs it. "Io ho una madre qui ora." points to nothing, since any noun fits; "Ora mia madre parla con me." points, and most of its words are the learner's. Its six wrong answers follow the gap rule and must each be wrong in the new sentence.`,
        ]
      : []),
    'A wrong answer of a "meaning" or "word" item must be plausible: the same part of speech, the same register and a',
    'similar length as the correct answer. A "gap" item\'s wrong answers follow the gap rule above instead.',
    'A wrong answer must never be right: not the correct answer itself, not a synonym of it, and',
    'not another valid translation of the word in any of its senses.',
    'When the word is broad (such as true, real, good or thing), its near neighbours are right in some use: take the wrong answers of its "meaning" and "word" items from another field of meaning.',
    `The six wrong answers of an item must differ from each other. Put the best first: the first ${KEPT_DISTRACTORS} that are usable are shown, and the rest stand by in case one is refused.`,
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

  // Phase 62 (spec D1): every item that writes a sentence builds it from the learner's words.
  const translates = input.items.some((item) => item.task === 'translate' || item.task === 'sentence' || item.task === 'gap');
  const learnerWords = translates && input.learnerWords && input.learnerWords.length > 0 ? input.learnerWords : null;
  const user = JSON.stringify({
    items: input.items.map((item) => ({
      key: item.key,
      task: item.task,
      word: item.form,
      lemma: item.lemma,
      part_of_speech: item.partOfSpeech,
      correct: item.translation,
      ...(item.task === 'gap' || item.task === 'sentence' || item.task === 'translate'
        ? { example: item.example, example_translation: item.exampleTranslation }
        : {}),
      ...(item.avoid.length > 0 ? { avoid: item.avoid } : {}),
      ...(item.rewrite ? { rewrite: rewriteJson(item.rewrite) } : {}),
    })),
    ...(related.length > 0
      ? { also_in_session: related.map((other) => ({ word: other.form, correct: other.translation })) }
      : {}),
    ...(learnerWords ? { learner_words: learnerWordsJson(learnerWords) } : {}),
  });

  return { system, user, schema: LlmDistractorsSchema };
}

/** Phase 62c (spec D3). A rewrite as the item's JSON carries it: only what is known. */
const rewriteJson = (rewrite: GapRewrite) => ({
  ...(rewrite.sentence ? { old_sentence: rewrite.sentence } : {}),
  ...(rewrite.fits.length > 0 ? { fits: rewrite.fits } : {}),
  ...(rewrite.problem ? { problem: rewrite.problem } : {}),
});

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
    items: cleaned.items.map((item) => {
      if (!isRecord(item)) return item;
      const listed = 'distractors' in item ? item : { ...item, distractors: [] };
      // Phase 38 (spec D2). A typed gap asks for as many alternatives as the schema
      // takes, so a surplus is trimmed here, the likeliest kept, never a refusal.
      return Array.isArray(listed.alternatives) && listed.alternatives.length > MAX_CARD_ALTERNATIVES
        ? { ...listed, alternatives: listed.alternatives.slice(0, MAX_CARD_ALTERNATIVES) }
        : listed;
    }),
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

/**
 * Phase 34 (spec D3, D4). A choice item's wrong options, one at a time: the
 * usable ones in the model's order, and why the first refused one was refused.
 * An option is refused when it is empty, repeats the answer or an earlier
 * option, is in the explanation language where the options are target words,
 * is a right answer of another row of the session (below), or is known right
 * to the dictionary: a meaning of the word or of a homograph on a meaning item,
 * a word right for the prompt on a word or gap item.
 */
function usableChoices(
  item: DistractorItem,
  items: DistractorItem[],
  others: readonly OtherRow[],
  found: string[],
  explanationLetters: RegExp,
  known: KnownRight,
): { usable: string[]; refusal: string | null } {
  // A word item's right answer is the form, and its lemma is right too; a gap
  // item's is also the text the example actually blanks (phase 27, spec D7).
  const isWord = item.task === 'word' || item.task === 'gap';
  const rights = isWord
    ? [item.form, item.lemma, ...(item.answerForm && item.task === 'word' ? [item.answerForm] : []), ...(item.blank ? [item.blank] : [])]
    : [item.translation];
  // Save-all stores every sense of a word, so the batch can hold the same
  // form twice; the other sense's translation is a right answer on a meaning
  // item. Turned round, two words with one meaning make each other right on a
  // word item.
  const siblings = new Set(
    [...items.filter((other) => other !== item), ...others]
      .filter((other) =>
        isWord
          ? comparable(other.translation) === comparable(item.translation)
          : comparable(other.form) === comparable(item.form),
      )
      .map((other) => comparable(isWord ? other.form : other.translation)),
  );
  const dictionary = new Set((isWord ? knownWords(known, item.translation) : knownMeanings(known, item.lexemeId)).map(comparable));
  const taken = new Set(rights.map(comparable));
  const usable: string[] = [];
  let refusal: string | null = null;
  for (const raw of found) {
    const text = raw.trim();
    const key = comparable(text);
    const why =
      text === ''
        ? `${item.key} has an empty wrong answer`
        : taken.has(key)
          ? `${item.key} repeats the answer or another wrong answer`
          : isWord && explanationLetters.test(text)
            ? `${item.key} offers a wrong answer in the explanation language where the options are ${item.form}'s`
            : siblings.has(key)
              ? isWord
                ? `${item.key} offers another saved word with the same meaning as a wrong answer`
                : `${item.key} offers another meaning of the same word as a wrong answer`
              : dictionary.has(key)
                ? isWord
                  ? `${item.key} offers ${text}, which the dictionary knows is right for ${item.translation}`
                  : `${item.key} offers ${text}, which the dictionary knows is a meaning of ${item.form}`
                : null;
    if (why) {
      refusal ??= why;
      continue;
    }
    taken.add(key);
    usable.push(text);
  }
  return { usable, refusal };
}

/** Alternatives for a typed card: trimmed, never empty, never the card's own
 *  form or lemma, no two alike under `comparable`, at most `limit`, in the order
 *  given. `accept` adds a caller's own refusal. */
function keepAlternatives(
  form: string,
  lemma: string,
  candidates: readonly string[],
  limit: number,
  accept: (text: string) => boolean = () => true,
): string[] {
  const seen = new Set([form, lemma].map(comparable));
  const kept: string[] = [];
  for (const raw of candidates) {
    const text = raw.trim();
    const key = comparable(text);
    if (text === '' || !accept(text) || seen.has(key)) continue;
    seen.add(key);
    kept.push(text);
    if (kept.length === limit) break;
  }
  return kept;
}

/** Never a refusal: alternatives only widen what a typed card accepts, so a
 *  bad one is dropped (empty, in the explanation language, the answer itself,
 *  a repeat) and the rest kept, up to MAX_ALTERNATIVES. */
function cleanAlternatives(item: DistractorItem, found: string[] | undefined, explanationLetters: RegExp): string[] {
  return keepAlternatives(item.form, item.lemma, found ?? [], MAX_ALTERNATIVES, (text) => !explanationLetters.test(text));
}

/**
 * Phase 48 (spec D1): per item, not all or nothing. A choice item with fewer
 * than three usable wrong options, or none answered, is refused with why, and
 * the batch goes on. A typed item cannot fail, and nor can a sentence or
 * translate item: it comes back `degraded` with the reason, and the service
 * turns that card into a typed translation (phase 27, spec D5, D6), which is
 * why it needs the `target` language its sentences are written in. A gap item
 * is a choice task like the others. Keys the model added beyond the items
 * asked are ignored. `explanation` is the language the meanings are in (the
 * enrollment's source): a reversed card's wrong words and a typed card's
 * alternatives must not be in its script.
 * `others` are the session's rows that ask the model nothing: their other
 * meanings and their words are as off limits as an item's own.
 *
 * Phase 34 (spec D3, D4). A choice item keeps the first three usable wrong
 * options of the six asked, and the rest, up to six in all, as spares; it fails
 * only when fewer than three are usable. `known` is what the dictionary already
 * holds as right.
 */
export function validateDistractors(
  items: DistractorItem[],
  answer: LlmDistractors,
  explanation: string,
  others: readonly OtherRow[],
  target: LanguageCode,
  known: KnownRight,
): DistractorVerdict {
  const explanationLetters = language(explanation).letters;
  const answered = new Map(answer.items.map((item) => [item.key, item]));
  const byKey = new Map<string, Generated>();
  const refused = new Map<string, string>();
  for (const item of items) {
    const found = answered.get(item.key);
    if (item.task === 'sentence' || item.task === 'translate') {
      const input = { form: item.form, target, explanation: explanation as LanguageCode, avoid: item.avoid };
      const checked = !found
        ? ({ ok: false, reason: `no answer for ${item.key}` } as const)
        : item.task === 'sentence'
          ? validateSentenceItem(input, found)
          : validateTranslateItem(input, found);
      byKey.set(
        item.key,
        checked.ok
          ? {
              ...NOTHING_GENERATED,
              sentence: item.task === 'sentence' ? (checked.content as SentenceContent) : null,
              translate: item.task === 'translate' ? (checked.content as TranslateContent) : null,
            }
          : { ...NOTHING_GENERATED, degraded: checked.reason },
      );
      continue;
    }
    if (item.task === 'typed') {
      // A typed item cannot fail: unanswered, it keeps no alternatives (phase 48, spec D1).
      byKey.set(item.key, { ...NOTHING_GENERATED, alternatives: cleanAlternatives(item, found?.alternatives, explanationLetters) });
      continue;
    }
    if (!found) {
      refused.set(item.key, `no answer for ${item.key}`);
      continue;
    }
    // Phase 62 (spec D1, ruling R7). A gap item's sentence is its own: an unusable
    // one refuses the card, and its wrong words are checked against its gap.
    let written: SentenceContent | null = null;
    if (item.task === 'gap') {
      const checked = validateSentenceItem({ form: item.form, target, explanation: explanation as LanguageCode, avoid: item.avoid }, found);
      if (!checked.ok) {
        refused.set(item.key, checked.reason);
        continue;
      }
      written = { ...checked.content, alternatives: [] };
    }
    const asked = written ? { ...item, blank: written.sentence.slice(written.gap.start, written.gap.end) } : item;
    const { usable, refusal } = usableChoices(asked, items, others, found.distractors, explanationLetters, known);
    if (usable.length < KEPT_DISTRACTORS) {
      refused.set(
        item.key,
        refusal
          ? `${refusal} (${usable.length} of ${found.distractors.length} usable, ${KEPT_DISTRACTORS} needed)`
          : `${item.key} needs three non-empty wrong answers`,
      );
      continue;
    }
    byKey.set(item.key, {
      ...NOTHING_GENERATED,
      distractors: usable.slice(0, KEPT_DISTRACTORS),
      spares: usable.slice(KEPT_DISTRACTORS, ASKED_DISTRACTORS),
      sentence: written,
    });
  }
  return { byKey, refused };
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
 *  never forced. Null when all are.
 *
 *  Phase 34 (spec D3, D4). `wrong` is every usable wrong meaning the first word
 *  has, spares included, and the fifth is also none that the dictionary knows
 *  for any of the four words or their homographs (1d268882: אחר כך is poi's own). */
export function boardMeanings(
  board: readonly GenerationContext[],
  session: readonly GenerationContext[],
  wrong: readonly string[],
  known: KnownRight,
): string[] | null {
  const meanings = board.map((row) => row.translation);
  // A board word's other saved meanings would show it twice on the board.
  const boardForms = new Set(board.map((row) => comparable(row.form)));
  const taken = new Set([
    ...meanings.map(comparable),
    ...session.filter((row) => boardForms.has(comparable(row.form))).map((row) => comparable(row.translation)),
    ...board.flatMap((row) => knownMeanings(known, row.lexemeId)).map(comparable),
  ]);
  const extra = wrong.map((text) => text.trim()).find((text) => !taken.has(comparable(text)));
  return extra === undefined ? null : [...meanings, extra];
}

/** What a position needs beyond the model's answer: a tiles card's tiles, and
 *  a board word's board (its meanings, and which of them is its own). */
export type Extras = {
  tiles: string[] | null;
  board: { meanings: string[]; own: number } | null;
};
export const NO_EXTRAS: Extras = { tiles: null, board: null };
export const NOTHING_GENERATED: Generated = { distractors: [], spares: [], alternatives: [], sentence: null, translate: null, degraded: null };

export type QuestionContent = {
  prompt: string | null;
  options: QuestionOption[] | null;
  alternatives: string[] | null;
  tiles: string[] | null;
  /** Phase 27 (spec D11). A sentence card's text, the Hebrew line shown with
   *  it, and the gap's offsets into `sentence`; all null for every other type. */
  sentence: string | null;
  sentenceTranslation: string | null;
  gapStart: number | null;
  gapEnd: number | null;
  /** Phase 34 (spec D2, D12). The form the card asks for when it is not the
   *  saved form, on the six types that ask for the word; null on every other. */
  answerForm: string | null;
};

/** Phase 34 (spec D2). The types that ask for the word, or show it beside the
 *  rendering, and so ask for the form that agrees with the rendering. */
const ASKS_FOR_FORM: ReadonlySet<QuestionType> = new Set([
  'multiple_choice',
  'listen_choice',
  'reverse_choice',
  'typed_translation',
  'say_translation',
  'letter_tiles',
]);

/**
 * Phase 23 and 24. One generated question's stored content (phase 23 D13,
 * phase 24 D15). Types whose options are Hebrew keep the meaning as their
 * correct option; every other type stores it as the prompt. The prompt is
 * stored, not joined: a question records what was asked.
 */
export function generatedContent(row: GenerationContext, type: QuestionType, generated: Generated, extras: Extras): QuestionContent {
  const none: QuestionContent = {
    prompt: null,
    options: null,
    alternatives: null,
    tiles: null,
    sentence: null,
    sentenceTranslation: null,
    gapStart: null,
    gapEnd: null,
    answerForm: null,
  };
  // Phase 34 (spec D2, D12). Stored as shown: a later backfill changes no asked card.
  const answerForm = ASKS_FOR_FORM.has(type) ? row.answerForm : null;
  switch (type) {
    case 'new_meaning':
      return refuseNewMeaning();
    case 'multiple_choice':
    case 'listen_choice':
      return { ...none, options: optionsFor(row.translation, generated.distractors), answerForm };
    case 'reverse_choice':
      return { ...none, prompt: row.translation, options: optionsFor(answerForm ?? row.form, generated.distractors), answerForm };
    case 'typed_translation':
    case 'say_translation':
      return { ...none, prompt: row.translation, alternatives: generated.alternatives, answerForm };
    case 'dictation':
    case 'read_aloud':
    case 'typed_meaning':
    case 'meet':
      // Phase 54 (spec D7). A meet card asks nothing: its prompt is the meaning it shows.
      return { ...none, prompt: row.translation };
    case 'cloze_choice': {
      // Phase 62 (spec D1): the sentence written for the session, its gap's text correct first.
      const content = generated.sentence;
      if (!content) throw new Error(`the cloze card for ${row.form} has no sentence`);
      const { gap } = content;
      // The right option keeps the sentence's case (capital when the word opens
      // it), so the wrong ones take the blank's first-letter case: it is no tell.
      const blank = content.sentence.slice(gap.start, gap.end);
      const upper = blank.charAt(0) !== blank.charAt(0).toLowerCase();
      const cased = generated.distractors.map((text) =>
        text === '' ? text : (upper ? text.charAt(0).toUpperCase() : text.charAt(0).toLowerCase()) + text.slice(1),
      );
      return {
        ...none,
        prompt: row.translation,
        options: optionsFor(blank, cased),
        sentence: content.sentence,
        sentenceTranslation: content.translation,
        gapStart: gap.start,
        gapEnd: gap.end,
      };
    }
    case 'cloze_typed': {
      const content = generated.sentence;
      if (!content) throw new Error(`the cloze card for ${row.form} has no sentence`);
      return {
        ...none,
        prompt: row.translation,
        alternatives: content.alternatives,
        sentence: content.sentence,
        sentenceTranslation: content.translation,
        gapStart: content.gap.start,
        gapEnd: content.gap.end,
      };
    }
    case 'sentence_translation': {
      // Spec D6: the Hebrew sentence is asked; the reference is what follows the answer.
      const content = generated.translate;
      if (!content) throw new Error(`the translation card for ${row.form} has no sentence`);
      return {
        ...none,
        prompt: row.translation,
        sentence: content.reference,
        sentenceTranslation: content.hebrew,
        gapStart: content.gap.start,
        gapEnd: content.gap.end,
      };
    }
    case 'letter_tiles':
      if (!extras.tiles) throw new Error(`the tiles card for ${row.form} has no tiles`);
      return { ...none, prompt: row.translation, tiles: extras.tiles, answerForm };
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

/** How many sibling headwords a typed or spoken card accepts before the session's alternatives. */
const SIBLINGS_FIRST = 3;

/**
 * Phase 31 (spec D18), with phase 34 (spec D1). A typed or spoken card's right
 * answers, in this order: the rendering's stored accepted answers, which the
 * accept job wrote once and every card of the rendering reads; up to three
 * sibling headwords, which are certain (`order` is right where להזמין asks for
 * `book`); this session's own alternatives, which the model wrote afresh; any
 * remaining siblings. Never the card's own form or lemma, no two alike, at most
 * MAX_CARD_ALTERNATIVES, the column check's ten. A stored answer is never
 * dropped for a later one, and with no stored list this is phase 31's order
 * exactly. Siblings are lemmas, while the model's alternatives are inflected to
 * the card's form, so a key with many sibling headwords must still leave room
 * for a right inflected synonym.
 */
export function withSiblingAlternatives(input: {
  form: string;
  lemma: string;
  /** The rendering's stored `accepted_answers`; none until its accept job has run. */
  accepted?: readonly string[];
  siblings: readonly string[];
  alternatives: readonly string[];
}): string[] {
  const first = keepAlternatives(input.form, input.lemma, input.siblings, SIBLINGS_FIRST);
  return keepAlternatives(
    input.form,
    input.lemma,
    [...(input.accepted ?? []), ...first, ...input.alternatives, ...input.siblings],
    MAX_CARD_ALTERNATIVES,
  );
}
