import type { QuestionSchema } from '@lang-tutor/core/api/schemas';
import { dimensionsTested, normaliseHebrew, type Dimension } from '@lang-tutor/core/domain';
import type { z } from 'zod';

import { guess } from './actr.ts';
import type { BotMemory, LearnEvent } from './memory.ts';
import { pick, type Rng } from './rng.ts';

/** Spec D16. How a bot answers one card. Pure: memory and rng are passed in, nothing is sent. */
export type Card = z.infer<typeof QuestionSchema>;

/**
 * A word the bot has saved: the target-language form and its Hebrew meaning, as its lookup
 * showed them. Cards show the gloss, which can differ: the lemma for an inflected form (хочешь,
 * asked as хотеть) and the gloss key for the meaning (רוצה, asked as לרצות). Either matches too.
 */
export type SavedWord = { form: string; meaning: string; lemma?: string; key?: string };

export type Behaviour = {
  /** Chance a recalled typed form has one letter wrong. */
  slip: number;
  /** Chance a failed typed or spoken card is given up rather than answered with another word. */
  gaveUp: number;
};

export type Outcome = 'right' | 'near_miss' | 'wrong' | 'gave_up' | 'unmatched';

export type Detail = {
  /** The saved word the card matched, or null. */
  word: string | null;
  unmatched: boolean;
  dimensions: Dimension[];
  /** The chance of a right answer drawn against, guessing floor included. 1 for read aloud, 0 if unmatched. */
  p: number;
  outcome: Outcome;
  /** The outcome as the grades table reads it, for `memory.learn`; null when nothing was learnt. */
  event: LearnEvent | null;
};

export type Action =
  | { kind: 'option'; index: number }
  | { kind: 'text'; text: string }
  | { kind: 'pass'; pass: 'show_answer' }
  | { kind: 'speak'; word: string };

export type Decision = Action & { detail: Detail };

/** Case-folded, Hebrew points removed, for comparing what a card shows with a saved word. */
const norm = (text: string) => normaliseHebrew(text).toLowerCase();

/** What a card shows, as candidates for the target-language form and the Hebrew meaning. */
function shown(card: Card): { forms: string[]; meanings: string[] } {
  const marked = (c: { sentence: string; gap: { start: number; end: number } }) => c.sentence.slice(c.gap.start, c.gap.end);
  switch (card.type) {
    case 'multiple_choice':
    case 'listen_choice':
    case 'dictation':
    case 'read_aloud':
    case 'typed_meaning':
    case 'matching':
      return { forms: [card.question], meanings: [] };
    case 'reverse_choice':
    case 'typed_translation':
    case 'letter_tiles':
    case 'say_translation':
      return { forms: [], meanings: [card.question] };
    case 'cloze_choice':
    case 'cloze_typed':
      // The gap may be blank or filled; either way the card also carries the stored meaning.
      return { forms: [marked(card)], meanings: [card.meaning] };
    case 'sentence_translation':
      return { forms: [card.answer, marked(card)], meanings: [card.meaning] };
  }
}

/** D16 step 1: the saved word the card shows, by form first, then by Hebrew meaning. */
export function matchCard(card: Card, saved: readonly SavedWord[]): SavedWord | null {
  const { forms, meanings } = shown(card);
  const is = (text: string | undefined, shown: string) => text !== undefined && norm(text) === norm(shown);
  for (const f of forms) {
    const hit = saved.find((w) => is(w.form, f)) ?? saved.find((w) => is(w.lemma, f));
    if (hit) return hit;
  }
  for (const m of meanings) {
    const hit = saved.find((w) => is(w.meaning, m)) ?? saved.find((w) => is(w.key, m));
    if (hit) return hit;
  }
  return null;
}

/** A form with one letter wrong: the letter at a drawn index becomes the next one in the alphabet. */
function nearMiss(text: string, rng: Rng): string {
  if (text === '') return text;
  const i = Math.floor(rng() * text.length);
  const next = String.fromCodePoint((text.codePointAt(i) ?? 97) + 1);
  return text.slice(0, i) + next + text.slice(i + 1);
}

function choiceCount(card: Card): number {
  return 'options' in card ? card.options.length : 0;
}

/** Another saved word, never the matched one; null when there is none. */
function otherWord(saved: readonly SavedWord[], not: SavedWord | null, rng: Rng): SavedWord | null {
  const others = saved.filter((w) => w !== not);
  return others.length > 0 ? pick(rng, others) : null;
}

function detail(partial: Partial<Detail> & Pick<Detail, 'outcome'>): Detail {
  return { word: null, unmatched: false, dimensions: [], p: 0, event: null, ...partial };
}

/** The text a typed card is answered with when right. */
function rightText(card: Card): string {
  switch (card.type) {
    case 'typed_translation':
    case 'letter_tiles':
    case 'cloze_typed':
    case 'say_translation':
      return card.answer;
    case 'sentence_translation':
      return card.sentence;
    case 'dictation':
    case 'read_aloud':
      return card.question;
    case 'typed_meaning':
      return card.meaning;
    default:
      return '';
  }
}

export function decide(card: Card, memory: BotMemory, saved: readonly SavedWord[], rng: Rng, behaviour: Behaviour): Decision {
  const type = card.type;

  // Read aloud retrieves nothing: the word is shown, the bot says it.
  if (card.type === 'read_aloud') {
    const word = matchCard(card, saved);
    return {
      kind: 'speak',
      word: card.question,
      detail: detail({ outcome: 'right', word: word?.form ?? null, p: 1, event: { type, verdict: 'understood' } }),
    };
  }

  const matched = matchCard(card, saved);
  const choice = choiceCount(card) > 0;
  const speaks = card.type === 'say_translation';

  // Step 1: a card the bot cannot match is answered at random.
  if (!matched) {
    const d = detail({ outcome: 'unmatched', unmatched: true });
    if (choice && 'options' in card) return { kind: 'option', index: Math.floor(rng() * card.options.length), detail: d };
    if (speaks) return { kind: 'pass', pass: 'show_answer', detail: d };
    const any = otherWord(saved, null, rng);
    return { kind: 'text', text: any?.form ?? '', detail: d };
  }

  // Steps 2 and 3: the card's dimensions; the weakest decides, then a draw against that recall.
  const dimensions = dimensionsTested(type);
  const recall = Math.min(...dimensions.map((dim) => memory.recall(matched.form, dim)));
  const p = choice ? guess(recall, choiceCount(card)) : recall;
  const right = rng() < p;
  const base = { word: matched.form, dimensions, p };

  // Step 4: the answer.
  if ('options' in card) {
    const n = card.options.length;
    if (right) {
      return { kind: 'option', index: card.correct_option, detail: detail({ ...base, outcome: 'right', event: { type, correct: true } }) };
    }
    // One of the others, uniformly.
    const slot = Math.min(n - 2, Math.floor(rng() * (n - 1)));
    const index = slot >= card.correct_option ? slot + 1 : slot;
    return { kind: 'option', index, detail: detail({ ...base, outcome: 'wrong', event: { type, correct: false } }) };
  }

  const hebrew = card.type === 'typed_meaning';
  if (right) {
    const target = rightText(card);
    if (speaks) {
      return { kind: 'speak', word: target, detail: detail({ ...base, outcome: 'right', event: { type, verdict: 'understood' } }) };
    }
    if (!hebrew && rng() < behaviour.slip) {
      return { kind: 'text', text: nearMiss(target, rng), detail: detail({ ...base, outcome: 'near_miss', event: { type, verdict: 'near_miss' } }) };
    }
    return { kind: 'text', text: target, detail: detail({ ...base, outcome: 'right', event: { type, verdict: 'exact' } }) };
  }

  // Wrong: give up, or answer with another word from the list.
  if (rng() < behaviour.gaveUp) {
    const event: LearnEvent = { type, verdict: 'gave_up' };
    if (speaks) return { kind: 'pass', pass: 'show_answer', detail: detail({ ...base, outcome: 'gave_up', event }) };
    return { kind: 'text', text: '', detail: detail({ ...base, outcome: 'gave_up', event }) };
  }
  const other = otherWord(saved, matched, rng);
  const event: LearnEvent = { type, verdict: 'wrong' };
  if (speaks) {
    return other
      ? { kind: 'speak', word: other.form, detail: detail({ ...base, outcome: 'wrong', event }) }
      : { kind: 'pass', pass: 'show_answer', detail: detail({ ...base, outcome: 'gave_up', event: { type, verdict: 'gave_up' } }) };
  }
  const text = other ? (hebrew ? other.meaning : other.form) : '';
  return { kind: 'text', text, detail: detail({ ...base, outcome: other ? 'wrong' : 'gave_up', event: other ? event : { type, verdict: 'gave_up' } }) };
}
