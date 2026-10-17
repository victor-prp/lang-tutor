import type { LlmContext } from '@lang-tutor/core/api';
import { LlmContextSchema } from '@lang-tutor/core/api/schemas';
import type { QuestionType } from '@lang-tutor/core/domain';

import { comparable, learnerWordsJson, type GenerationContext, type LearnerWord } from './distractors';
import { LANGUAGES, type LanguageCode } from './languages';
import { findMark, findMarks, type Mark } from './marks';
import { SENTENCE_MAX_WORDS, SENTENCE_MIN_WORDS, SHORT_SENTENCE_MAX_WORDS, wordCount } from './sentences';
import { dropNulls, unfence } from './translation';

/**
 * Phase 34 (spec D6, D7, D8). The sentences that pin a card's sense: a context
 * sentence beside a card that shows a bare word, and the practised word marked
 * in a sentence card's Hebrew. One call per session, after the batch (ruling
 * R8: the four strings made the batch hang; R11: a sentence card's mark needs
 * the batch's sentence). Pure (ADR 0001 R3): the prompt, the parse, the rules,
 * the fallback. services/sessions.ts calls the model and decides what a failure
 * costs, which is never the session.
 */

/** In the instruction verbatim, so MockServer can tell this call apart.
 *  Changing the wording means changing the stubs. */
export const CONTEXT_MARKER = 'pins the sense';

/** Spec D6: the language of the sentence a card shows beside its word. The
 *  explanation language (Hebrew) beside a Hebrew prompt, the target language
 *  beside a target word; null for a card that shows none (letter tiles, listen
 *  choice, matching, dictation, read aloud and the sentence cards, D6's "not on"). */
export type ContextLanguage = 'explanation' | 'target';

export function contextLanguageOf(type: QuestionType): ContextLanguage | null {
  switch (type) {
    case 'typed_translation':
    case 'say_translation':
    case 'reverse_choice':
      return 'explanation';
    case 'typed_meaning':
    case 'multiple_choice':
      return 'target';
    default:
      return null;
  }
}

/** Spec D8: the two sentence cards whose Hebrew names the practised word. */
const MARKS_SENTENCE: ReadonlySet<QuestionType> = new Set(['cloze_typed', 'sentence_translation']);
/** Phase 62 (spec D2). The sentence cards the call maps word by word, and so asks
 *  a mark item of: the two above, and a cloze choice, whose mark is not stored. */
const MAPPED_SENTENCE: ReadonlySet<QuestionType> = new Set([...MARKS_SENTENCE, 'cloze_choice']);

/** A card's context as stored (spec D12): the sentence shown, its other half
 *  (never shown, read by the judge, D7), and the marked word, or null. */
export type StoredContext = { text: string; translation: string | null; mark: Mark | null };

/** Per gloss (phase 31) and card type, the context sentences this
 *  enrollment's last sessions showed, newest first. Read by the service. */
export type RecentContexts = Map<string /* glossId */, Partial<Record<QuestionType, string[]>>>;

/** One bare-word card's request: a sentence in `task`'s language using `shown`. */
export type BareContextItem = {
  key: string;
  task: ContextLanguage;
  /** The word the card shows, which the sentence uses and marks: the rendering
   *  for a Hebrew sentence; for a target one the form the card shows. */
  shown: string;
  /** The target-language word the card asks for (a Hebrew sentence's); the form shown otherwise. */
  answer: string;
  lemma: string;
  partOfSpeech: string;
  /** The rendering, what the word means in the explanation language. */
  meaning: string;
  example: string | null;
  exampleTranslation: string | null;
  /** Spec D6: what a Hebrew sentence must never hold, every right answer of the
   *  card, one of each under `comparable`. Empty for a target sentence. */
  refused: string[];
  /** Spec D6: the last sentences this gloss showed on this card type. */
  recent: string[];
  /** Phase 62 (spec D2). A target sentence: the call also maps each word of its
   *  translation to the sentence's, as a mark item's map does. */
  map?: boolean;
};

/** One sentence card's request (spec D8): which words of its Hebrew stand for `word`. */
export type MarkItem = {
  key: string;
  task: 'mark';
  /** The practised word as the target sentence writes it (the gap's text). */
  word: string;
  meaning: string;
  /** The Hebrew sentence the card shows, which the mark points into. */
  sentence: string;
  /** Its target-language sentence. */
  translation: string;
  /** Phase 59 (spec D2). A translation card: the call also maps each Hebrew word.
   *  Phase 62: a gap card too, whose map the service turns onto its sentence. */
  map?: boolean;
};

export type ContextItem = BareContextItem | MarkItem;

/** Structurally LlmJsonRequest; services/sessions.ts is where the two meet. */
export type ContextPrompt = { system: string; user: string; schema: typeof LlmContextSchema };

const unique = (texts: readonly string[]): string[] => {
  const seen = new Set<string>();
  return texts.filter((text) => {
    const key = comparable(text);
    if (key === '' || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * What one position asks, or null when it asks nothing. `alternatives` are the
 * card's own (a typed card's list); `sentence` is a sentence card's validated
 * Hebrew and target sentence and its gap's text, or null when it has none (it
 * degraded, and its type says so).
 */
export function contextItemFor(input: {
  key: string;
  type: QuestionType;
  row: GenerationContext;
  alternatives: readonly string[];
  recent: readonly string[];
  sentence: { hebrew: string; target: string; word: string } | null;
}): ContextItem | null {
  const { key, type, row } = input;
  if (MAPPED_SENTENCE.has(type)) {
    return input.sentence
      ? {
          key,
          task: 'mark',
          word: input.sentence.word,
          meaning: row.translation,
          sentence: input.sentence.hebrew,
          translation: input.sentence.target,
          map: true,
        }
      : null;
  }
  const task = contextLanguageOf(type);
  if (!task) return null;
  // Phase 34 (spec D2): the cards that ask for the word ask for the answer form;
  // a typed meaning shows the saved form (repo/questions' questionFrom).
  const asked = row.answerForm ?? row.form;
  const shown = task === 'explanation' ? row.translation : type === 'typed_meaning' ? row.form : asked;
  return {
    key,
    task,
    shown,
    answer: task === 'explanation' ? asked : shown,
    lemma: row.lemma,
    partOfSpeech: row.partOfSpeech,
    meaning: row.translation,
    example: row.example,
    exampleTranslation: row.exampleTranslation,
    refused:
      task === 'explanation'
        ? unique([row.form, row.lemma, ...(row.answerForm ? [row.answerForm] : []), ...row.acceptedAnswers, ...input.alternatives])
        : [],
    recent: [...input.recent],
    // Phase 62 (spec D2): a target sentence is tapped word by word; a Hebrew one is not (R1).
    ...(task === 'target' ? { map: true } : {}),
  };
}

function language(code: string) {
  const found = LANGUAGES[code as LanguageCode];
  if (!found) throw new Error(`no language ${code}`);
  return found;
}

/** What the prompt asks for. The rules allow a little more either side
 *  (SENTENCE_MIN_WORDS to SENTENCE_MAX_WORDS), so a sentence one word off is
 *  not lost to the fallback. Phase 62 (spec D1): the Hebrew sentence's alone; a
 *  target sentence is asked and kept to SHORT_SENTENCE_MAX_WORDS, as a gap's is. */
const ASKED_WORDS = '4 to 10';
const MAX_WORDS: Record<ContextLanguage, number> = { target: SHORT_SENTENCE_MAX_WORDS, explanation: SENTENCE_MAX_WORDS };

/** The saved example's half a sentence in `task`'s language would repeat. */
const exampleHalf = (item: BareContextItem): string | null =>
  item.task === 'target' ? item.example : item.exampleTranslation;

export function buildContextPrompt(input: {
  items: ContextItem[];
  from: string;
  to: string;
  /** Phase 59 (spec D2): sent only when a mark item is mapped. */
  learnerWords?: readonly LearnerWord[];
}): ContextPrompt {
  const learned = language(input.from);
  const explained = language(input.to);
  const system = [
    `You write the sentences for a ${learned.name} vocabulary quiz for a ${explained.name}-speaking learner.`,
    'Return JSON only, matching the supplied schema.',
    'A card that shows a word alone does not say which of its senses it asks for. A short sentence beside the word',
    `${CONTEXT_MARKER}: it uses the word in the one sense the card practises, so that a reader can tell that sense, and no other, from the sentence alone.`,
    'Each item has a task:',
    `- "target": the card shows the ${learned.name} word in word, which means meaning in ${explained.name}. In context, write a short, natural, everyday ${learned.name} sentence of ${SENTENCE_MIN_WORDS} to ${SHORT_SENTENCE_MAX_WORDS} words that uses word exactly as it is written there, once, in the sense of meaning and of the example, never in another sense. When learner_words is given, the learner knows only those ${learned.name} words and word itself: build the sentence from word and learner_words, in whatever form each needs, adding another word only where the sentence cannot stand, or cannot show the sense, without it, and then a simple one (a pronoun, an article, a preposition, or the verb to be or to have); showing the sense comes first, then a short sentence, then the learner's words. Count its words: never more than ${SHORT_SENTENCE_MAX_WORDS}. In context_word, write word as it appears in context. In context_translation, write the whole sentence in natural ${explained.name}. When the item has map, also fill sentence_words as a mark item's, with context_translation as its sentence and context as its translation.`,
    `- "explanation": the card shows the ${explained.name} word in word, which translates the ${learned.name} word in translates. In context, write a short, natural, everyday ${explained.name} sentence of ${ASKED_WORDS} words that uses word once, in whatever form the sentence needs, in the sense in which it translates translates and the example shows, never in another sense. Never write a ${learned.name} word in it. In context_word, write that ${explained.name} word exactly as it is written in context, with any prefix it takes. In context_translation, write the whole sentence in natural ${learned.name}.`,
    `- "mark": sentence is a ${explained.name} sentence, and translation is a ${learned.name} translation of it that uses word, which means meaning. In sentence_word, write the ${explained.name} word or words of sentence that stand for word, exactly as they are written in sentence, with any prefix. Leave context, context_translation and context_word empty. When the item has map, also fill sentence_words, in the order of sentence, with every word of sentence in exactly one entry. An entry is one word of sentence, or several words of sentence that the translation renders together, such as יש לי rendered by a single word for "I have": never split those into entries with an empty translation. In hebrew, write the entry's words exactly as written in sentence, with any prefix; in translation, the words of translation that render them, exactly as written in translation, empty only when translation renders them with nothing at all; in word, the key of the learner_words entry they render, in any form, or empty.`,
    'A sentence must differ from every sentence in avoid.',
    'Answer every item, using its key exactly as given.',
    ...explained.writing,
    ...learned.writing,
  ].join('\n');

  // Phase 62 (spec D2): a target item is mapped too.
  const mapped = input.items.some((item) => item.map);
  const user = JSON.stringify({
    items: input.items.map((item) => {
      if (item.task === 'mark') {
        return {
          key: item.key,
          task: item.task,
          word: item.word,
          meaning: item.meaning,
          sentence: item.sentence,
          translation: item.translation,
          ...(item.map ? { map: true } : {}),
        };
      }
      // Spec D6: generated, not copied from the saved example, and never last time's.
      const avoid = unique([...(exampleHalf(item) ? [exampleHalf(item)!] : []), ...item.recent]);
      return {
        key: item.key,
        task: item.task,
        word: item.shown,
        ...(item.task === 'explanation' ? { translates: item.answer } : {}),
        lemma: item.lemma,
        part_of_speech: item.partOfSpeech,
        ...(item.task === 'target' ? { meaning: item.meaning } : {}),
        example: item.example,
        example_translation: item.exampleTranslation,
        ...(avoid.length > 0 ? { avoid } : {}),
        ...(item.map ? { map: true } : {}),
      };
    }),
    ...(mapped && input.learnerWords && input.learnerWords.length > 0 ? { learner_words: learnerWordsJson(input.learnerWords) } : {}),
  });
  return { system, user, schema: LlmContextSchema };
}

/** `null` means unreadable; the caller decides what that costs (never the
 *  session, ruling R11). A null field is "none", as in the batch. */
export function parseLlmContext(raw: string): LlmContext | null {
  let json: unknown;
  try {
    json = JSON.parse(unfence(raw));
  } catch {
    return null;
  }
  const result = LlmContextSchema.safeParse(dropNulls(json));
  return result.success ? result.data : null;
}

type Found = LlmContext['items'][number];

/** Gap offsets are UTF-16 indices and the database counts characters (sentences.ts). */
const ASTRAL = /[\u{10000}-\u{10FFFF}]/u;

/** A phrase's words, in order, among a text's words, both under `comparable`. */
function holds(text: string, phrase: string): boolean {
  const words = (value: string) => comparable(value).split(/[^\p{L}\p{M}\p{N}']+/u).filter(Boolean);
  const all = words(text);
  const sought = words(phrase);
  return sought.length > 0 && all.some((_, at) => sought.every((word, offset) => all[at + offset] === word));
}

type Verdict = { ok: true; context: StoredContext } | { ok: false; reason: string };

/** Spec D6's rules over one answered sentence. */
function validate(item: BareContextItem, found: Found | undefined, languages: { target: LanguageCode; explanation: LanguageCode }): Verdict {
  const fail = (reason: string): Verdict => ({ ok: false, reason });
  const text = found?.context?.trim() ?? '';
  const translation = found?.context_translation?.trim() ?? '';
  if (text === '') return fail(`no sentence for ${item.key}`);
  if (translation === '') return fail('the sentence has no translation');
  if (ASTRAL.test(text) || ASTRAL.test(translation)) return fail('the sentence holds a character outside the basic plane');
  const words = wordCount(text);
  if (words < SENTENCE_MIN_WORDS || words > MAX_WORDS[item.task]) return fail(`the sentence has ${words} words`);

  const own = item.task === 'target' ? languages.target : languages.explanation;
  const other = item.task === 'target' ? languages.explanation : languages.target;
  // A Hebrew sentence never holds the target-language answer (D6), looked for
  // first so the reason names it.
  const held = item.refused.find((answer) => holds(text, answer));
  if (held) return fail(`the sentence holds the answer ${held}`);
  if (!LANGUAGES[own].letters.test(text) || LANGUAGES[other].letters.test(text)) {
    return fail(`the sentence is not written in ${LANGUAGES[own].name} alone`);
  }
  if (!LANGUAGES[other].letters.test(translation) || LANGUAGES[own].letters.test(translation)) {
    return fail(`the translation is not written in ${LANGUAGES[other].name} alone`);
  }
  if (item.recent.some((old) => comparable(old) === comparable(text))) return fail('the sentence repeats a recent one');

  // A target sentence shows the form the card shows (D6's "marks the card's
  // form"); a Hebrew one inflects it, so its mark is best effort.
  if (item.task === 'target') {
    if (findMarks(text, item.shown).length === 0) return fail(`the sentence does not show ${item.shown}`);
    return { ok: true, context: { text, translation, mark: findMark(text, item.shown) } };
  }
  const named = found?.context_word?.trim();
  const mark = (named ? findMark(text, named) : null) ?? findMark(text, item.shown);
  return { ok: true, context: { text, translation, mark } };
}

/**
 * Spec D6, ruling R2. The one fallback: the saved example's half in the
 * card's language, unmarked, with the other half as the hidden translation;
 * null when the sense has no such half (the card is then as it was before
 * phase 34, and the service logs `context_missing`). Task 6's checker calls it
 * when it drops a sentence.
 */
export function fallbackContext(
  saved: { example: string | null; exampleTranslation: string | null },
  language: ContextLanguage,
): StoredContext | null {
  const shown = (language === 'target' ? saved.example : saved.exampleTranslation)?.trim();
  const hidden = (language === 'target' ? saved.exampleTranslation : saved.example)?.trim();
  return shown ? { text: shown, translation: hidden || null, mark: null } : null;
}

/** What a bare-word card stores, and why the model's sentence was not it. */
export type ContextOutcome = { context: StoredContext | null; dropped: string | null };

/** One card's context: the model's sentence when it keeps D6's rules, else the fallback. */
export function resolveContext(
  item: BareContextItem,
  found: Found | undefined,
  languages: { target: LanguageCode; explanation: LanguageCode },
): ContextOutcome {
  const verdict = validate(item, found, languages);
  return verdict.ok ? { context: verdict.context, dropped: null } : { context: fallbackContext(item, item.task), dropped: verdict.reason };
}

/** Spec D8: the practised word in a sentence card's Hebrew, or null. A null
 *  mark keeps the sentence: the card shows it unmarked. */
export function markFor(item: MarkItem, found: Found | undefined): Mark | null {
  const named = found?.sentence_word?.trim();
  return named ? findMark(item.sentence, named) : null;
}

/** The question columns (spec D12), each only where questions_shape_valid
 *  allows it, and a mark only where questions_marks_valid would: inside its
 *  sentence, start before end. */
export type ContextColumns = {
  context: string | null;
  contextTranslation: string | null;
  contextMarkStart: number | null;
  contextMarkEnd: number | null;
  sentenceMarkStart: number | null;
  sentenceMarkEnd: number | null;
};

const fits = (mark: Mark | null, text: string): mark is Mark =>
  mark !== null && Number.isInteger(mark.start) && Number.isInteger(mark.end) && mark.start >= 0 && mark.start < mark.end && mark.end <= text.length;

export function contextColumns(
  type: QuestionType,
  context: StoredContext | null,
  sentence: { text: string; mark: Mark | null } | null,
): ContextColumns {
  const shown = contextLanguageOf(type) !== null ? context : null;
  const contextMark = shown && fits(shown.mark, shown.text) ? shown.mark : null;
  const sentenceMark = MARKS_SENTENCE.has(type) && sentence && fits(sentence.mark, sentence.text) ? sentence.mark : null;
  return {
    context: shown?.text ?? null,
    contextTranslation: shown?.translation ?? null,
    contextMarkStart: contextMark?.start ?? null,
    contextMarkEnd: contextMark?.end ?? null,
    sentenceMarkStart: sentenceMark?.start ?? null,
    sentenceMarkEnd: sentenceMark?.end ?? null,
  };
}

/** Phase 59 (spec D2). One tappable run of a translation card's Hebrew: where it
 *  is, the reference's words for it, the list word it renders (never the card's
 *  own), and whether it is the practised word. */
export type MapWord = { start: number; end: number; text: string; glossId: string | null; target: boolean };

/** The words of a text, under `comparable`, as `holds` reads them. */
const wordsOf = (value: string) => comparable(value).split(/[^\p{L}\p{M}\p{N}']+/u).filter(Boolean);

const overlaps = (a: Mark, b: Mark) => a.start < b.end && b.start < a.end;

/**
 * Phase 59 (spec D2). A translation card's word map, from the context call's
 * answer, or null when it has none usable. Never a refusal: a bad entry costs
 * that word its tap. Each Hebrew word is found after the one before it; an entry
 * whose Italian is not in the reference, or that overlaps one already kept, is
 * dropped. The target is every entry over the mark, or with no mark the entry
 * whose Italian holds every word of the gap; with a mark no entry covers, the mark itself, with
 * the gap's text. Any other entry sharing a word with the gap is dropped, so a
 * free tap never shows the answer.
 */
export function wordMapFor(
  item: MarkItem,
  found: Found | undefined,
  mark: Mark | null,
  learner: readonly LearnerWord[],
  ownGlossId: string,
): MapWord[] | null {
  if (!item.map || !found?.sentence_words) return null;
  const gapWords = new Set(wordsOf(item.word));
  const glossOf = new Map(learner.map((word) => [word.key, word.glossId]));
  const kept: MapWord[] = [];
  let cursor = 0;
  for (const entry of found.sentence_words) {
    const text = entry.translation.trim();
    const hebrew = entry.hebrew.trim();
    if (text === '' || hebrew === '' || !holds(item.translation, text)) continue;
    const at = findMarks(item.sentence, hebrew).find((place) => place.start >= cursor);
    if (!at || kept.some((word) => overlaps(word, at))) continue;
    cursor = at.end;
    // With no mark, the entry that holds every word of the gap (un fratello for fratello).
    const target = mark ? overlaps(at, mark) : gapWords.size > 0 && [...gapWords].every((word) => wordsOf(text).includes(word));
    if (!target && wordsOf(text).some((word) => gapWords.has(word))) continue;
    const glossId = target ? null : (glossOf.get(entry.word.trim()) ?? null);
    kept.push({ start: at.start, end: at.end, text, glossId: glossId === ownGlossId ? null : glossId, target });
  }
  if (mark && !kept.some((word) => word.target)) {
    kept.push({ start: mark.start, end: mark.end, text: item.word, glossId: null, target: true });
    kept.sort((a, b) => a.start - b.start);
  }
  return kept.length > 0 ? kept : null;
}

/** Phase 59 (spec D5). A word map as the card is served it: never the list's glosses. */
export const servedWords = (words: readonly MapWord[] | null) =>
  words ? words.map(({ start, end, text, target }) => ({ start, end, text, target })) : null;

/** One entry of the call's map as it answers it (LlmContextSchema's `sentence_words`):
 *  words of the Hebrew, and the target-language words that render them. */
type MapEntry = { hebrew: string; translation: string; word: string };

/**
 * Phase 62 (spec D2). A target-language sentence's word map: a gap card's sentence
 * or a context line, each with its Hebrew `translation`. The call maps the Hebrew
 * word by word, as for a translation card, and this turns each entry round onto
 * `text`: its span is where its target-language words are, and what a tap shows
 * is its Hebrew. Never a refusal: a bad entry costs that word its tap.
 *
 * - An entry with an empty side, whose Hebrew is not in `translation`, or whose
 *   words are nowhere in `text` that no kept entry already holds, is dropped. The
 *   two languages order words differently, so each is looked for anywhere.
 * - `target` (the gap, or the context's mark) is the practised word's tap, exactly
 *   its span: its Hebrew is the first entry's over it, or `meaning`. Any other
 *   entry over it is dropped, so the gap stays the gap.
 * - A free entry whose Hebrew holds `meaning` is dropped: on a word card that is
 *   the answer, and a tap must never show it.
 */
export function italianWordMap(input: {
  text: string;
  translation: string;
  target: Mark | null;
  meaning: string;
  entries: readonly MapEntry[] | undefined;
  learner: readonly LearnerWord[];
  ownGlossId: string;
}): MapWord[] | null {
  if (!input.entries) return null;
  const { target } = input;
  const glossOf = new Map(input.learner.map((word) => [word.key, word.glossId]));
  const kept: MapWord[] = [];
  let targetText: string | null = null;
  for (const entry of input.entries) {
    const hebrew = entry.hebrew.trim();
    const words = entry.translation.trim();
    if (hebrew === '' || words === '' || !holds(input.translation, hebrew)) continue;
    const at = findMarks(input.text, words).find((place) => !kept.some((word) => overlaps(word, place)));
    if (!at) continue;
    if (target && overlaps(at, target)) {
      targetText ??= hebrew;
      continue;
    }
    if (holds(hebrew, input.meaning)) continue;
    const glossId = glossOf.get(entry.word.trim()) ?? null;
    kept.push({ start: at.start, end: at.end, text: hebrew, glossId: glossId === input.ownGlossId ? null : glossId, target: false });
  }
  if (target) kept.push({ start: target.start, end: target.end, text: targetText ?? input.meaning, glossId: null, target: true });
  kept.sort((a, b) => a.start - b.start);
  return kept.length > 0 ? kept : null;
}
