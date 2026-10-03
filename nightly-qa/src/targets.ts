import { z } from 'zod';

import { categoryFromLabels } from './categories.ts';

/**
 * Which issues the categoriser looks at tonight. Decided in code, before any
 * model starts, so the answer to "why did it touch #40?" is a rule rather than
 * a transcript.
 */

/** On the report issue and nothing else. Deliberately not `nightly-qa`. */
export const REPORT_LABEL = 'nightly-qa-triage-report';

const commentSchema = z.object({
  author: z.object({ login: z.string() }).nullable().optional(),
  body: z.string(),
  createdAt: z.string(),
});

export const trackerSchema = z.array(
  z.object({
    number: z.number().int().positive(),
    title: z.string(),
    state: z.string(),
    labels: z.array(z.object({ name: z.string() })),
    body: z.string().nullable().transform((b) => b ?? ''),
    createdAt: z.string(),
    comments: z.array(commentSchema).default([]),
  }),
);
export type TrackerIssue = z.infer<typeof trackerSchema>[number];

export const filedSchema = z.object({
  created: z.array(z.number().int().positive()).default([]),
  commented: z.array(z.number().int().positive()).default([]),
});
export type Filed = z.infer<typeof filedSchema>;

export const metaSchema = z.object({
  date: z.string(),
  targets: z.array(z.number().int().positive()),
  carried: z.array(z.number().int().positive()),
});
export type Meta = z.infer<typeof metaSchema>;

export const isOpen = (issue: TrackerIssue): boolean => issue.state.toLowerCase() === 'open';
const names = (issue: TrackerIssue): string[] => issue.labels.map((l) => l.name);

export function selectTargets(
  issues: TrackerIssue[],
  filed: Filed,
  cap: number,
): { targets: TrackerIssue[]; carried: number[] } {
  const touched = new Set([...filed.created, ...filed.commented]);
  const eligible = issues
    .filter((issue) => isOpen(issue))
    .filter((issue) => !names(issue).includes(REPORT_LABEL))
    .filter((issue) => touched.has(issue.number) || categoryFromLabels(names(issue)) === null)
    .sort((a, b) => a.number - b.number);
  return { targets: eligible.slice(0, cap), carried: eligible.slice(cap).map((i) => i.number) };
}

/** Labels that are a category's answer, rather than evidence about the issue. */
const ANSWERS = new Set(['duplicate', 'by-design', 'known-issue']);

/** For calibration: the issue as it looked before anyone decided it. */
export function stripTriage(issue: TrackerIssue): TrackerIssue {
  return {
    ...issue,
    labels: issue.labels.filter((l) => !l.name.startsWith('triage:') && !ANSWERS.has(l.name)),
    body: issue.body
      .split('\n')
      .filter((line) => !line.trim().startsWith('**Duplicate of:**'))
      .join('\n'),
  };
}
