import type { LlmContext } from '@lang-tutor/core/api';
import { normaliseHebrew } from '@lang-tutor/core/domain';

import { findGap } from '../../src/domain/cloze';
import { contextItemFor, italianWordMap, markFor, resolveContext, wordMapFor, type ContextItem } from '../../src/domain/context';
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

/** Phase 62. The learner's words as the prompts are sent them, keyed w1, w2, … */
const learnerOf = (kase: ContextCase) =>
  (kase.learner ?? []).map((entry, index) => ({ key: `w${index + 1}`, glossId: `g-w${index + 1}`, ...entry }));

/** Phase 62 (spec D2). A target-language sentence's map: the practised word its
 *  target, and at least one other word a tap can show. */
function lineMapped(map: ReturnType<typeof italianWordMap>, entries: unknown): Check {
  const ok = map !== null && map.some((word) => word.target) && map.some((word) => !word.target);
  return { name: 'the sentence is mapped, its word the target and another word tappable', ok, detail: JSON.stringify(map ?? entries ?? null) };
}

/** Phase 62 (spec D1). As run.ts's listShare: the share of the line's words, its
 *  own word left out, from the learner's list, at a word's first four letters. */
export const LINE_LIST_SHARE_THRESHOLD = 0.5;
function listShareOf(text: string, own: string, learner: { word: string }[]): Check {
  const listWords = [...new Set(learner.flatMap((entry) => entry.word.toLowerCase().split(/\s+/u)))];
  const fromList = (token: string) =>
    listWords.some((word) => token === word || (word.length >= 4 && token.length >= 4 && token.slice(0, 4) === word.slice(0, 4)));
  const ownWords = new Set(own.toLowerCase().split(/\s+/u));
  const tokens = text.toLowerCase().split(/[^\p{L}\p{M}]+/u).filter((token) => token !== '' && !ownWords.has(token)).filter((token) => token.length > 2 || fromList(token));
  const share = tokens.length === 0 ? 1 : tokens.filter(fromList).length / tokens.length;
  return { name: "the line is built from the learner's list", ok: share >= LINE_LIST_SHARE_THRESHOLD, detail: `${(share * 100).toFixed(0)}%: ${text}` };
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
    // Phase 62 (spec D2): a gap card's map, turned onto its target-language sentence.
    if (kase.type !== 'sentence_translation') {
      const gap = findGap(item.translation, [item.word]);
      checks.push(lineMapped(italianWordMap({ text: item.translation, translation: item.sentence, target: gap, meaning: kase.translation, entries: got?.sentence_words, learner: learnerOf(kase), ownGlossId: 'g-c' }), got?.sentence_words));
      return checks;
    }
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
  // Phase 62 (spec D1, D2): a target-language line is mapped, its word the target,
  // and built from the learner's list as much as it can.
  const line = outcome.dropped === null ? outcome.context : null;
  if (item.task === 'target' && item.map && line?.translation) {
    checks.push(lineMapped(italianWordMap({ text: line.text, translation: line.translation, target: line.mark, meaning: kase.translation, entries: got?.sentence_words, learner: learnerOf(kase), ownGlossId: 'g-c' }), got?.sentence_words));
  }
  if (kase.learner && line) checks.push(listShareOf(line.text, kase.form, kase.learner));
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
