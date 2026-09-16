import { z } from 'zod';

import type { Finding, QaReport, Severity } from './findings.ts';
import { severities } from './findings.ts';

/**
 * What the `file` job knows about the tracker, and how an issue carries enough
 * structure to be recognised again tomorrow.
 *
 * The fingerprint lives in the issue body rather than anywhere clever, because
 * the body is the one field that survives every edit a human might make to an
 * issue: retitling, relabelling, moving it around a project board.
 */

/** The last line of every issue this bot opens. Parsed back out by parseFingerprint. */
const FINGERPRINT_LABEL = '**Fingerprint:**';

export function parseFingerprint(body: string): string | null {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(FINGERPRINT_LABEL)) continue;
    const match = trimmed.slice(FINGERPRINT_LABEL.length).match(/`([^`]+)`/);
    if (match) return match[1].trim();
  }
  return null;
}

export function severityFromLabels(labels: string[]): Severity | null {
  return severities.find((s) => labels.includes(s)) ?? null;
}

const rawIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  labels: z.array(z.object({ name: z.string() })),
  body: z.string().nullable().default(''),
});

export const knownIssuesSchema = z.array(rawIssueSchema).transform((rows) =>
  rows.map((row) => {
    const labels = row.labels.map((l) => l.name);
    const body = row.body ?? '';
    return {
      number: row.number,
      title: row.title,
      state: row.state.toLowerCase() === 'open' ? ('open' as const) : ('closed' as const),
      labels,
      body,
      fingerprint: parseFingerprint(body),
      severity: severityFromLabels(labels),
    };
  }),
);

export type KnownIssue = z.infer<typeof knownIssuesSchema>[number];

/**
 * The issue body. Fixed template, and the fingerprint is last so that a human
 * appending notes to the issue never pushes it out of reach of the parser -
 * parseFingerprint scans every line, but keeping it last also keeps it visible.
 */
export function renderIssueBody(finding: Finding, run: QaReport['run']): string {
  const steps = finding.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const evidence: string[] = [];
  if (finding.evidence.network) evidence.push(`**Network:** ${finding.evidence.network}`);
  if (finding.evidence.console.length > 0) {
    evidence.push(`**Console:** ${finding.evidence.console.join(' / ')}`);
  }

  return [
    `Found by the nightly QA agent on ${run.date}, as **${run.persona}** looking at **${run.focus}**.`,
    '',
    `**Screen:** ${finding.screen}`,
    '',
    '**Steps**',
    '',
    steps,
    '',
    `**Expected:** ${finding.expected}`,
    '',
    `**Observed:** ${finding.observed}`,
    '',
    ...(evidence.length > 0 ? [evidence.join('\n\n'), ''] : []),
    '<!-- screenshots -->',
    '',
    `**Fingerprint:** \`${finding.fingerprint}\``,
    '',
  ].join('\n');
}
