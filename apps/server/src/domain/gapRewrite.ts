import type { LlmDistractors } from '@lang-tutor/core/api';

import type { CheckItem } from './check';
import { KEPT_DISTRACTORS, type DistractorItem, type DistractorVerdict, type GapRewrite, type OtherRow } from './distractors';
import type { SentenceContent } from './sentences';

/**
 * Phase 62c (spec D2). A gap to choose that is asked again, once: validation
 * refused it, or the gap check left it fewer than three wrong options. `rewrite`
 * is what the model is told of its last sentence. Phase 62d (spec D3): or a typed
 * gap whose sentence the point check found pointing to nothing.
 */
export type GapFault = { key: string; stage: 'validation' | 'checker' | 'pointing'; rewrite: GapRewrite };

/** Phase 62c (spec D1). What the gap check found, for the items it judged: each
 *  option asked, and whether the checker calls it right. */
export type GapJudged = ReadonlyMap<string, { options: string[]; alsoRight: boolean[] }>;

/** Phase 62 (spec D1). A gap item as the checker reads it: the sentence written, its gap ___. */
export function gapCheckItem(key: string, sentence: SentenceContent, options: string[]): CheckItem {
  const { start, end } = sentence.gap;
  return { key, task: 'gap', sentence: `${sentence.sentence.slice(0, start)}___${sentence.sentence.slice(end)}`, options };
}

/**
 * Phase 62c (spec D2). The gap items to ask again, validation's refusals first,
 * then those the gap check left short, each in item order. A refused item's last
 * sentence is its raw answer's, null when it wrote none. An item the gap check did
 * not judge (`judged` is null when the check failed) is no checker fault: the
 * final checker reads it.
 */
export function gapFaults(input: {
  items: readonly DistractorItem[];
  answer: LlmDistractors | null;
  verdict: DistractorVerdict;
  judged: GapJudged | null;
}): GapFault[] {
  const gaps = input.items.filter((item) => item.task === 'gap');
  const refused = gaps.flatMap((item): GapFault[] => {
    const problem = input.verdict.refused.get(item.key);
    if (!problem) return [];
    const sentence = input.answer?.items.find((answered) => answered.key === item.key)?.sentence ?? null;
    return [{ key: item.key, stage: 'validation', rewrite: { sentence, fits: [], problem } }];
  });
  const short = gaps.flatMap((item): GapFault[] => {
    const found = input.judged?.get(item.key);
    const written = input.verdict.byKey.get(item.key)?.sentence;
    if (!found || !written) return [];
    const fits = found.options.filter((_, at) => found.alsoRight[at]);
    if (found.options.length - fits.length >= KEPT_DISTRACTORS) return [];
    return [{ key: item.key, stage: 'checker', rewrite: { sentence: written.sentence, fits, problem: null } }];
  });
  return [...refused, ...short];
}

/**
 * Phase 62d (spec D3). The typed gaps to ask again, in item order: each sentence
 * item the point check failed, told its old sentence, what a reader guessed
 * instead, and why. One with no sentence written was degraded by validation and
 * is not rescued here.
 */
export function pointFaults(input: {
  items: readonly DistractorItem[];
  verdict: DistractorVerdict;
  failed: ReadonlyMap<string, { fits: string[]; problem: string }>;
}): GapFault[] {
  return input.items.flatMap((item): GapFault[] => {
    const found = input.failed.get(item.key);
    const written = input.verdict.byKey.get(item.key)?.sentence;
    if (item.task !== 'sentence' || !found || !written) return [];
    return [{ key: item.key, stage: 'pointing', rewrite: { sentence: written.sentence, fits: found.fits, problem: found.problem } }];
  });
}

/** Phase 62c (spec D3). Each fault's item, asked again: its rewrite, and its last sentence added to what it avoids. */
export function rewriteItems(items: readonly DistractorItem[], faults: readonly GapFault[]): DistractorItem[] {
  return faults.flatMap((fault) => {
    const item = items.find((candidate) => candidate.key === fault.key);
    if (!item) return [];
    const last = fault.rewrite.sentence;
    return [{ ...item, rewrite: fault.rewrite, avoid: last && !item.avoid.includes(last) ? [...item.avoid, last] : item.avoid }];
  });
}

/** Phase 62c (spec D3). What a rewrite must keep clear of: the session's other rows,
 *  and every item not asked again, by word and meaning. */
export function rewriteOthers(items: readonly DistractorItem[], faults: readonly GapFault[], others: readonly OtherRow[]): OtherRow[] {
  const asked = new Set(faults.map((fault) => fault.key));
  return [...others, ...items.filter((item) => !asked.has(item.key)).map((item) => ({ form: item.form, translation: item.translation }))];
}
