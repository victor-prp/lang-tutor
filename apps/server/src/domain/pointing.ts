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

/** Phase 62d (spec D3). How many times a typed gap the reader cannot place is written
 *  again, each told what the last one's readers would write. One rescued about half of
 *  the eval's (2026-10-18), and a second, given new feedback, most of the rest. */
export const POINT_REWRITE_ROUNDS = 2;

/** In the instruction verbatim, so MockServer can tell this call apart.
 *  Changing the wording means changing the stubs. */
export const POINT_MARKER = 'never seen the word';

/** A typed gap as the reader sees it: `sentence` holds ___ where the word was. */
export type PointItem = { key: string; sentence: string };

/** Structurally LlmJsonRequest; services/sessions.ts is where the two meet. */
export type PointPrompt = { system: string; user: string; schema: typeof LlmPointSchema };

/** What the reader said of one sentence: its guesses, likeliest first, the first one's
 *  meaning, and how many of ten readers would write the first or a word of its meaning. */
export type PointFinding = { guesses: string[]; meaning: string; readers: number };

/** Spec D2, ruling R1: the first guess is clearly the likeliest when at least this many
 *  readers of ten would write it. The model estimates and the code decides, so the bar is
 *  set against Victor's verdicts (the eval's pointing group) without rewording the prompt. */
export const POINT_READERS = 6;

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
    '- guesses: the three words you would most likely put in the gap, the likeliest first, each in word, in the form the gap needs, and in readers how many of them would write it: picture ten native readers, each seeing only this sentence and writing one word in the gap. A reader who would write a word that means the same as one of your guesses counts for that guess. Each reader counts once, so the three counts add up to ten at most, and words of different meanings (a wife and a husband, a dog and a cat, a taxi and a bus) are counted apart, however natural each would be.',
    `- meaning: your first guess translated into ${own.name}, in its dictionary form.`,
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
    const guesses = got.guesses.map((guess) => ({ word: guess.word.trim(), readers: guess.readers })).filter((guess) => guess.word !== '');
    read.set(got.key, { guesses: guesses.map((guess) => guess.word), meaning: got.meaning.trim(), readers: guesses[0]?.readers ?? 0 });
  }
  return read;
}

/** Spec D2: the first guess is the word or of its meaning, and clearly the likeliest (POINT_READERS). */
export function judgePoint(finding: PointFinding, target: PointTarget): PointVerdict {
  const [first] = finding.guesses;
  if (first === undefined) return { points: false, fits: [], problem: 'a reader who covers the word guesses nothing' };
  const isWord = (guess: string) => judgeTyped(target.word, guess) !== 'wrong';
  const others = finding.guesses.filter((guess) => !isWord(guess));
  if (!isWord(first) && !meaningFits(finding.meaning, target.meanings)) {
    return { points: false, fits: others, problem: `a reader who covers the word guesses ${first} first (${finding.guesses.join(', ')})` };
  }
  if (finding.readers < POINT_READERS) {
    return { points: false, fits: others, problem: `only ${finding.readers} of ten readers who cover the word would write it; the others would write ${others.join(', ') || 'other words'}` };
  }
  return { points: true };
}
