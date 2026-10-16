import type { LlmContext } from '@lang-tutor/core/api';
import { normaliseHebrew } from '@lang-tutor/core/domain';

import { contextItemFor, markFor, resolveContext, wordMapFor, type ContextItem } from '../../src/domain/context';
import { comparable } from '../../src/domain/distractors';
import { isInScript } from '../../src/domain/languages';
import type { ContextCase } from './cases';

/**
 * Phase 34 (spec D6, D8; ruling R3). How a context case is scored, apart from
 * run.ts so a check can be shown to fire on a hand-made answer without a call
 * (run.ts runs the whole eval when it is imported).
 */
export type Check = { name: string; ok: boolean; detail?: string };

/** The one item a context case asks, as prepareSession builds it. */
export function contextItemOf(kase: ContextCase): ContextItem {
  const item = contextItemFor({
    key: 'q1',
    type: kase.type,
    row: {
      glossId: 'g-c', senseId: 's-c', variantId: 'v-c', lexemeId: 'l-c',
      form: kase.form, lemma: kase.lemma, partOfSpeech: kase.partOfSpeech, translation: kase.translation,
      example: kase.example, exampleTranslation: kase.exampleTranslation,
      acceptedAnswers: kase.acceptedAnswers ?? [], answerForm: null, acceptedAt: null,
    },
    alternatives: [],
    recent: [],
    sentence: kase.sentence ? { hebrew: kase.sentence.hebrew, target: kase.sentence.target, word: kase.sentence.word } : null,
  });
  if (!item) throw new Error(`${kase.label}: the ${kase.type} card asks no context`);
  return item;
}

/** A Hebrew text's words, points and punctuation gone, each also without a
 *  one-letter prefix (ו ה ב כ ל מ ש), so ושראה finds ראה. */
function hebrewWords(text: string): string[] {
  return normaliseHebrew(text)
    .split(' ')
    .filter(Boolean)
    .flatMap((word) => (word.length > 2 && 'והבכלמש'.includes(word[0]) ? [word, word.slice(1)] : [word]));
}

/** Ruling R3: the scripts, which a sentence that is no context at all would break. */
export function contextTier1(kase: ContextCase, answer: LlmContext): Check[] {
  const item = contextItemOf(kase);
  const got = answer.items.find((answered) => answered.key === item.key);
  if (item.task === 'mark') {
    return [{ name: 'the practised word is named', ok: Boolean(got?.sentence_word?.trim()), detail: got?.sentence_word }];
  }
  const own = item.task === 'target' ? kase.target : 'he';
  const other = item.task === 'target' ? 'he' : kase.target;
  const text = got?.context ?? '';
  const translation = got?.context_translation ?? '';
  return [
    { name: `the sentence is in ${own} script`, ok: text.trim() !== '' && isInScript(text, own), detail: text || '(none)' },
    { name: `its other half is in ${other} script`, ok: translation.trim() !== '' && isInScript(translation, other), detail: translation || '(none)' },
  ];
}

/** Ruling R3: kept by the server's rules, the marked word a form of the card's
 *  word, and the hidden Hebrew in the card's sense, not another word's. */
export function contextTier2(kase: ContextCase, answer: LlmContext): Check[] {
  const item = contextItemOf(kase);
  const got = answer.items.find((answered) => answered.key === item.key);
  if (item.task === 'mark') {
    const mark = markFor(item, got);
    const marked = mark ? item.sentence.slice(mark.start, mark.end) : null;
    const checks: Check[] = [{ name: `${kase.sentence!.marked} is marked`, ok: marked !== null && comparable(marked) === comparable(kase.sentence!.marked), detail: marked ?? `${got?.sentence_word ?? '(none)'} not found` }];
    // Phase 59: each expected run is tappable, with the reference's words for it.
    const map = wordMapFor(item, got, mark, [], 'g-c') ?? [];
    for (const run of kase.mapped ?? []) {
      const found = map.find((word) => comparable(item.sentence.slice(word.start, word.end)) === comparable(run.hebrew));
      checks.push({
        name: `${run.hebrew} is tappable as ${run.translation}`,
        ok: found !== undefined && comparable(found.text) === comparable(run.translation),
        detail: JSON.stringify(got?.sentence_words ?? null),
      });
    }
    return checks;
  }
  const outcome = resolveContext(item, got, { target: kase.target, explanation: 'he' });
  const word = comparable(got?.context_word ?? '');
  const checks: Check[] = [{ name: 'the server keeps the sentence', ok: outcome.dropped === null, detail: outcome.dropped ?? undefined }];
  // A word that begins with "saw" is never see or seen: this is R3's
  // "context_word is not see/seen" too.
  if (kase.formsOf) {
    checks.push({ name: `context_word is a form of ${kase.formsOf.join('/')}`, ok: kase.formsOf.some((form) => word.startsWith(comparable(form))), detail: got?.context_word ?? '(none)' });
  }
  // "I saw him yesterday" uses the form saw and passes every check above. Its
  // Hebrew does not: ראיתי, not a form of לנסר.
  const words = hebrewWords(got?.context_translation ?? '');
  if (kase.translationRoot) {
    const root = kase.translationRoot;
    checks.push({ name: `the Hebrew holds a form of ${root.source}`, ok: words.some((hebrew) => root.test(hebrew)), detail: got?.context_translation ?? '(none)' });
  }
  if (kase.translationNotWords) {
    const others = kase.translationNotWords.map((other) => normaliseHebrew(other));
    const found = words.filter((hebrew) => others.includes(hebrew));
    checks.push({ name: `the Hebrew holds none of ${kase.translationNotWords.slice(0, 3).join('/')}…`, ok: found.length === 0, detail: found.length ? found.join(', ') : undefined });
  }
  return checks;
}

export const contextWritten = (kase: ContextCase, answer: LlmContext): string[] =>
  answer.items.map((got) =>
    contextItemOf(kase).task === 'mark'
      ? `${kase.form}: ${kase.sentence?.hebrew ?? ''} [${got.sentence_word ?? '(none)'}]`
      : `${kase.form}: ${got.context ?? '(none)'} [${got.context_word ?? ''}] = ${got.context_translation ?? '(none)'}`,
  );
