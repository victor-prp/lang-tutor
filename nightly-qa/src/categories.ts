import { z } from 'zod';

import type { KnownIssue } from './knownIssues.ts';

/**
 * What the categoriser may decide, and what each decision means on the tracker.
 *
 * The model picks a category and nothing else. Which labels go on, and whether
 * the issue is closed, is read from these tables - so "the model decided to close
 * this" is not a sentence that can be true.
 */

export const categories = [
  'duplicate',
  'working-as-intended',
  'real_bug',
  'translation_quality',
  'missing-feature',
  'ux-polish',
] as const;
export type Category = (typeof categories)[number];

export const CATEGORY_LABEL: Record<Category, string> = {
  duplicate: 'triage:duplicate',
  'working-as-intended': 'triage:working-as-intended',
  real_bug: 'triage:real-bug',
  translation_quality: 'triage:translation-quality',
  'missing-feature': 'triage:missing-feature',
  'ux-polish': 'triage:ux-polish',
};

/**
 * `duplicate` and `by-design` are labels file.ts already reads; `known-issue` is
 * the one the explorer's brief reads. Reusing them is what makes a category
 * change tomorrow night's behaviour without new code on that side.
 */
export const CATEGORY_LABELS: Record<Category, string[]> = {
  duplicate: ['triage:duplicate', 'duplicate'],
  'working-as-intended': ['triage:working-as-intended', 'by-design'],
  real_bug: ['triage:real-bug'],
  translation_quality: ['triage:translation-quality'],
  'missing-feature': ['triage:missing-feature'],
  'ux-polish': ['triage:ux-polish', 'known-issue'],
};

export const CLOSING: ReadonlySet<Category> = new Set<Category>(['duplicate', 'working-as-intended']);

export function categoryFromLabels(labels: string[]): Category | null {
  return categories.find((c) => labels.includes(CATEGORY_LABEL[c])) ?? null;
}

const decisionSchema = z.object({
  issue: z.number().int().positive(),
  category: z.enum(categories),
  duplicate_of: z.number().int().positive().optional(),
  // Two steps, not the explorer's three. A session that reaches for "medium"
  // is saying it is not sure, which is what low means: applied, and
  // highlighted in the report. Anything else is still a broken file.
  confidence: z.preprocess((v) => (v === 'medium' ? 'low' : v), z.enum(['high', 'low'])),
  rationale: z.string().min(1),
  evidence: z.array(z.string()).default([]),
});

const ruleGapSchema = z.object({
  issues: z.array(z.number().int().positive()),
  description: z.string().min(1),
  suggested_change: z.string().min(1),
});

export const categoriesFileSchema = z.object({
  decisions: z.array(decisionSchema),
  rule_gaps: z.array(ruleGapSchema).default([]),
});

export type TriageDecision = z.infer<typeof decisionSchema>;
export type RuleGap = z.infer<typeof ruleGapSchema>;
export type CategoriesFile = z.infer<typeof categoriesFileSchema>;

/**
 * All or nothing. A file that is half right is a session that went wrong
 * somewhere, and applying the half that parsed would act on a run nobody
 * understands. The job fails and the artifact is there to read.
 */
export function parseCategoriesFile(
  raw: string | null,
): { ok: true; file: CategoriesFile } | { ok: false; error: string } {
  if (raw === null) {
    return { ok: false, error: 'No categories.json: the session wrote nothing. Nothing was changed.' };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: `categories.json is not valid JSON (${(error as Error).message}). Nothing was changed.`,
    };
  }
  const result = categoriesFileSchema.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      error: `categories.json does not match the contract: ${result.error.message}. Nothing was changed.`,
    };
  }
  return { ok: true, file: result.data };
}

export type Refusal = { decision: TriageDecision; reason: string };
export type Checked = {
  accepted: TriageDecision[];
  refused: Refusal[];
  undecided: number[];
  ignored: TriageDecision[];
};

export function checkDecisions(file: CategoriesFile, targets: number[], known: KnownIssue[]): Checked {
  const targetSet = new Set(targets);
  const byNumber = new Map(known.map((issue) => [issue.number, issue]));
  const ignored = file.decisions.filter((d) => !targetSet.has(d.issue));
  const onTargets = file.decisions.filter((d) => targetSet.has(d.issue));

  const counts = new Map<number, number>();
  for (const d of onTargets) counts.set(d.issue, (counts.get(d.issue) ?? 0) + 1);

  const refused: Refusal[] = [];
  const candidates: TriageDecision[] = [];
  for (const d of onTargets) {
    // meta.json names the targets, but the tracker says what they are. A
    // target that is not a nightly-qa issue is never acted on.
    if (!byNumber.get(d.issue)?.labels.includes('nightly-qa')) {
      refused.push({ decision: d, reason: `#${d.issue} is not a nightly-qa issue` });
      continue;
    }
    if ((counts.get(d.issue) ?? 0) > 1) {
      refused.push({ decision: d, reason: `#${d.issue} has more than one decision` });
      continue;
    }
    if (d.category === 'working-as-intended' && d.evidence.length === 0) {
      refused.push({ decision: d, reason: 'working-as-intended needs a citation in evidence' });
      continue;
    }
    if (d.category === 'duplicate') {
      if (d.duplicate_of === undefined) {
        refused.push({ decision: d, reason: 'duplicate needs duplicate_of' });
        continue;
      }
      if (d.duplicate_of === d.issue) {
        refused.push({ decision: d, reason: 'an issue cannot be a duplicate of itself' });
        continue;
      }
      const original = byNumber.get(d.duplicate_of);
      if (!original || original.state !== 'open') {
        refused.push({ decision: d, reason: `#${d.duplicate_of} is not an open nightly-qa issue` });
        continue;
      }
    }
    candidates.push(d);
  }

  // Conservative on purpose: an original that is a closing candidate at all
  // refuses its duplicates, even if the original is itself refused later. A
  // chain left for tomorrow costs a night; a duplicate pointing at a closed
  // duplicate costs a human untangling it.
  const closing = new Set(candidates.filter((d) => CLOSING.has(d.category)).map((d) => d.issue));
  const accepted: TriageDecision[] = [];
  for (const d of candidates) {
    if (d.category === 'duplicate' && d.duplicate_of !== undefined && closing.has(d.duplicate_of)) {
      refused.push({ decision: d, reason: `#${d.duplicate_of} is itself being closed tonight` });
      continue;
    }
    accepted.push(d);
  }

  const decided = new Set([...accepted, ...refused.map((r) => r.decision)].map((d) => d.issue));
  const undecided = targets.filter((n) => !decided.has(n));
  return { accepted, refused, undecided, ignored };
}
