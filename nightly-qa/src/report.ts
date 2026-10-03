import type { Checked, RuleGap } from './categories.ts';
import type { Change } from './triage.ts';

/**
 * The owner's one notification a night. What needs a human goes first; the
 * rest is the record, there to be checked rather than read.
 */

export function reportTitle(date: string): string {
  return `[nightly-qa] Triage report ${date}`;
}

export type ReportInput = {
  date: string;
  runUrl: string | null;
  checked: Checked;
  changes: Change[];
  ruleGaps: RuleGap[];
  carried: number[];
  /** Issue → the error from the gh command that stopped its change partway. */
  failures: Map<number, string>;
  titles: Map<number, string>;
};

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' ');
const refs = (issues: number[]): string => issues.map((n) => `#${n}`).join(', ');

export function renderReport(r: ReportInput): string {
  const title = (n: number) => r.titles.get(n) ?? '';
  const attention: string[] = [];

  for (const c of r.changes.filter((c) => c.decision.confidence === 'low')) {
    attention.push(
      `- #${c.decision.issue} ${title(c.decision.issue)} — low confidence: **${c.to}**, ${c.action}. ${cell(c.decision.rationale)}`,
    );
  }
  for (const gap of r.ruleGaps) {
    attention.push(`- Rule gap (${refs(gap.issues)}): ${cell(gap.description)} — suggested: ${cell(gap.suggested_change)}`);
  }
  for (const refusal of r.checked.refused) {
    attention.push(`- #${refusal.decision.issue} ${title(refusal.decision.issue)} — not applied: ${refusal.reason}`);
  }
  for (const [n, error] of r.failures) {
    attention.push(`- #${n} ${title(n)} — failed to apply: ${cell(error)}. It keeps no category, so the next night retries it`);
  }
  for (const n of r.checked.undecided) {
    attention.push(`- #${n} ${title(n)} — undecided: the session returned no decision; nothing was changed`);
  }

  const lines = [
    '## Needs your attention',
    '',
    ...(attention.length > 0 ? attention : ['_Nothing needs your attention._']),
    '',
    '## All decisions',
    '',
    '| Issue | Category | Action | Confidence | Rationale |',
    '|---|---|---|---|---|',
    ...r.changes.map((c) => {
      const category = c.from && c.from !== c.to ? `${c.from} → ${c.to}` : c.to;
      const action = r.failures.has(c.decision.issue) ? `FAILED: ${c.action}` : c.action;
      return `| #${c.decision.issue} | ${category} | ${action} | ${c.decision.confidence} | ${cell(c.decision.rationale)} |`;
    }),
  ];

  if (r.carried.length > 0) {
    lines.push('', '## Carried over', '', `${refs(r.carried)} — over tonight's cap; they are first in line tomorrow.`);
  }
  if (r.checked.ignored.length > 0) {
    lines.push('', '## Ignored', '', `Decisions on issues that were not targets: ${refs(r.checked.ignored.map((d) => d.issue))}.`);
  }
  if (r.runUrl) lines.push('', `[The run](${r.runUrl})`);

  return lines.join('\n') + '\n';
}
