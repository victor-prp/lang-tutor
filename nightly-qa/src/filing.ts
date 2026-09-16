import type { Finding, QaReport, Severity } from './findings.ts';
import type { KnownIssue } from './knownIssues.ts';

/**
 * Every decision about what reaches the tracker, and nothing else.
 *
 * Pure by design: no gh, no filesystem, no clock. The rules are the part that
 * has to be right, and the only way to keep them testable against real sessions
 * is to keep the side effects in file.ts.
 */

export type Action =
  | {
      kind: 'comment';
      issue: number;
      finding: Finding;
      escalateTo?: Severity;
      /** The issue was closed and this finding reproduced it anyway. */
      reopened: boolean;
    }
  | { kind: 'create'; finding: Finding; possibleDuplicateOf: number[] }
  | { kind: 'skip'; finding: Finding; reason: string };

export type Neighbour = { finding: string; issue: number; shared: string };
export type Decision = { actions: Action[]; neighbours: Neighbour[] };

const RANK: Record<Severity, number> = { inconvenience: 0, weird: 1, bug: 2 };
export function severityRank(severity: Severity): number {
  return RANK[severity];
}

/**
 * Labels that mean a human has already ruled on this. The bot does not reopen
 * that argument nightly; it drops the finding silently into the summary.
 */
const SETTLED = ['wontfix', "won't fix", 'by-design', 'not-planned'];

const normalise = (fingerprint: string): string =>
  fingerprint
    .split('|')
    .map((part) => part.trim().toLowerCase().replace(/\s+/g, ' '))
    .join(' | ');

const screenAndElement = (fingerprint: string): string =>
  normalise(fingerprint).split(' | ').slice(0, 2).join(' | ');

export function decide(
  report: QaReport,
  known: KnownIssue[],
  options: { maxNew: number },
): Decision {
  const byNumber = new Map(known.map((issue) => [issue.number, issue]));
  const open = known.filter((issue) => issue.state === 'open');
  const actions: Action[] = [];
  const neighbours: Neighbour[] = [];
  const creations: { finding: Finding; possibleDuplicateOf: number[] }[] = [];

  for (const finding of report.findings) {
    if (finding.confidence === 'low') {
      actions.push({ kind: 'skip', finding, reason: 'low confidence is reported, never filed' });
      continue;
    }

    if (!finding.match) {
      actions.push({
        kind: 'skip',
        finding,
        reason: 'no deduplication decision: the session ended before the match pass',
      });
      continue;
    }

    if ('issue' in finding.match) {
      const issue = byNumber.get(finding.match.issue);
      if (!issue) {
        actions.push({
          kind: 'skip',
          finding,
          reason: `matched issue ${finding.match.issue} is not a known nightly-qa issue`,
        });
        continue;
      }

      if (issue.state === 'closed' && issue.labels.some((l) => SETTLED.includes(l.toLowerCase()))) {
        actions.push({
          kind: 'skip',
          finding,
          reason: `issue ${issue.number} is closed as by-design or wontfix; a decision was already taken`,
        });
        continue;
      }

      // Escalate only upward. A quieter night is not evidence the problem got
      // smaller - it is evidence the agent did not reach the worse path.
      const escalateTo =
        issue.severity && severityRank(finding.severity) > severityRank(issue.severity)
          ? finding.severity
          : undefined;

      actions.push({
        kind: 'comment',
        issue: issue.number,
        finding,
        escalateTo,
        reopened: issue.state === 'closed',
      });
      continue;
    }

    // match.new
    const fingerprint = normalise(finding.fingerprint);
    const prefix = screenAndElement(finding.fingerprint);

    const possibleDuplicateOf = open
      .filter((issue) => issue.fingerprint && normalise(issue.fingerprint) === fingerprint)
      .map((issue) => issue.number);

    for (const issue of open) {
      if (!issue.fingerprint) continue;
      if (possibleDuplicateOf.includes(issue.number)) continue;
      if (screenAndElement(issue.fingerprint) === prefix) {
        neighbours.push({ finding: finding.id, issue: issue.number, shared: prefix });
      }
    }

    creations.push({ finding, possibleDuplicateOf });
  }

  // Bugs before weird before inconveniences, and a stable order within a rank so
  // the same report always files the same issues.
  creations.sort((a, b) => severityRank(b.finding.severity) - severityRank(a.finding.severity));

  creations.forEach((creation, index) => {
    if (index < options.maxNew) {
      actions.push({ kind: 'create', ...creation });
    } else {
      actions.push({
        kind: 'skip',
        finding: creation.finding,
        reason: `over the cap of ${options.maxNew} new issues a night`,
      });
    }
  });

  return { actions, neighbours };
}
