import type { LlmPoint } from '@lang-tutor/core/api';
import { LlmPointSchema } from '@lang-tutor/core/api/schemas';
import { judgeTyped, type TypedTarget } from '@lang-tutor/core/domain';

import { meaningFits } from './check';
import { LANGUAGES, type LanguageCode } from './languages';
import type { SentenceContent } from './sentences';
import { dropNulls, unfence } from './translation';

/**
 * Phase 62d (spec D2). Whether a typed gap's sentence points to its word: a
 * reader who sees only the sentence, its word left out, guesses what goes in
 * the gap. Pure (ADR 0001 R3): the prompt, the parse, and what the guess means.
 * services/sessions.ts calls the model, and a call that fails keeps its cards.
 *
 * The bar is Victor's (ruling R1): the reader's first guess is the word, or a
 * word of its meaning, and one meaning is clearly the likeliest. A sentence that
 * narrows the gap to a kind ("Mio ___ è felice.", any person) does not point.
 */

/** In the instruction verbatim, so MockServer can tell this call apart.
 *  Changing the wording means changing the stubs. */
export const POINT_MARKER = 'never seen the word';

/** A typed gap as the reader sees it: `sentence` holds ___ where the word was. */
export type PointItem = { key: string; sentence: string };

/** Structurally LlmJsonRequest; services/sessions.ts is where the two meet. */
export type PointPrompt = { system: string; user: string; schema: typeof LlmPointSchema };

/** What the reader said of one sentence. */
export type PointFinding = { guesses: string[]; meaning: string; clear: boolean };

/** The word a typed gap asks, by its own forms only, and the meanings its gloss is known by. */
export type PointTarget = { word: TypedTarget; meanings: readonly string[] };

/** A sentence that does not point carries what the rewrite is told: the reader's other guesses, and why. */
export type PointVerdict = { points: true } | { points: false; fits: string[]; problem: string };

function language(code: string) {
  const found = LANGUAGES[code as LanguageCode];
  if (!found) throw new Error(`no language ${code}`);
  return found;
}

/** Spec D2: the stored sentence with its gap written ___. */
export function pointItem(key: string, sentence: SentenceContent): PointItem {
  const { start, end } = sentence.gap;
  return { key, sentence: `${sentence.sentence.slice(0, start)}___${sentence.sentence.slice(end)}` };
}

/** `from` is the language learned, `to` the learner's own. The word is never sent (spec D2: blind). */
export function buildPointPrompt(items: readonly PointItem[], from: string, to: string): PointPrompt {
  const learned = language(from);
  const own = language(to);
  const system = [
    `Each item is a ${learned.name} sentence with one word left out, written ___.`,
    `Read each as a native ${learned.name} speaker who has ${POINT_MARKER}: only the sentence.`,
    'Return JSON only, matching the supplied schema. For each item:',
    `- guesses: the three words you would most likely put in the gap, the likeliest first, each in the form the gap needs.`,
    `- meaning: your first guess translated into ${own.name}, in its dictionary form.`,
    '- clear: true when one meaning is clearly the likeliest, so that most readers would put your first guess or a word meaning the same; false when words of different meanings fit the gap about as well, or the sentence only narrows it to a kind (any person, any vehicle, any thing one can have).',
    'Answer every item, using its key exactly as given.',
    ...own.writing,
    ...learned.writing,
  ].join('\n');
  const user = JSON.stringify({ items: items.map((item) => ({ key: item.key, sentence: item.sentence })) });
  return { system, user, schema: LlmPointSchema };
}

/** `null` means unreadable; the caller keeps its cards (spec D3). */
export function parsePoint(raw: string): LlmPoint | null {
  let json: unknown;
  try {
    json = JSON.parse(unfence(raw));
  } catch {
    return null;
  }
  const result = LlmPointSchema.safeParse(dropNulls(json));
  return result.success ? result.data : null;
}

/** Each asked item's finding. A key not answered is left out: its card is kept as
 *  written (spec D3). Keys the model added are ignored, and of two answers for one
 *  key the first counts. */
export function readPoint(items: readonly PointItem[], answer: LlmPoint): Map<string, PointFinding> {
  const asked = new Set(items.map((item) => item.key));
  const read = new Map<string, PointFinding>();
  for (const got of answer.items) {
    if (!asked.has(got.key) || read.has(got.key)) continue;
    read.set(got.key, {
      guesses: got.guesses.map((guess) => guess.trim()).filter((guess) => guess !== ''),
      meaning: got.meaning.trim(),
      clear: got.clear,
    });
  }
  return read;
}

/** Spec D2: the first guess is the word or of its meaning, and clearly the likeliest. */
export function judgePoint(finding: PointFinding, target: PointTarget): PointVerdict {
  const [first] = finding.guesses;
  if (first === undefined) return { points: false, fits: [], problem: 'a reader who covers the word guesses nothing' };
  const isWord = (guess: string) => judgeTyped(target.word, guess) !== 'wrong';
  const others = finding.guesses.filter((guess) => !isWord(guess));
  if (!finding.clear) {
    return { points: false, fits: others, problem: `words of different meanings fit its gap about as well: ${finding.guesses.join(', ')}` };
  }
  if (isWord(first) || meaningFits(finding.meaning, target.meanings)) return { points: true };
  return { points: false, fits: others, problem: `a reader who covers the word guesses ${first} first` };
}
