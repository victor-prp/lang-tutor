import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

import { pushEvidence } from './evidence.ts';
import { decide, type Action } from './filing.ts';
import { parseReportLoose, shotBasename } from './findings.ts';
import { knownIssuesSchema, renderIssueBody } from './knownIssues.ts';

const MAX_NEW = 3;

const [findingsPath, knownPath, ...flags] = process.argv.slice(2);
const apply = flags.includes('--apply');

if (!findingsPath || !knownPath) {
  console.error('usage: tsx nightly-qa/src/file.ts <findings.json> <known-issues.json> [--apply]');
  process.exit(2);
}

const { report, dropped } = parseReportLoose(JSON.parse(readFileSync(findingsPath, 'utf8')));
const known = knownIssuesSchema.parse(JSON.parse(readFileSync(knownPath, 'utf8')));

const shotUrls = pushEvidence(report.run.date, `${findingsPath.replace(/\/[^/]+$/, '')}/shots`, apply);

if (!report.run.browser_ok) {
  console.error('browser_ok is false: the session never drove the app. Filing nothing.');
  process.exit(1);
}

const { actions, neighbours } = decide(report, known, { maxNew: MAX_NEW });

const lines: string[] = [
  `# Nightly QA — ${report.run.date}`,
  '',
  `Persona **${report.run.persona}**, focus **${report.run.focus}**. ` +
    `${report.findings.length} findings kept, ${dropped.length} dropped.`,
  '',
];

function gh(args: string[]): string {
  if (!apply) {
    console.log(`  would run: gh ${args.join(' ')}`);
    return '';
  }
  return execFileSync('gh', args, { encoding: 'utf8' });
}

/**
 * A finding cites `shots/f1.png`; the tracker needs a URL. Anything the run did
 * not actually produce resolves to nothing and is dropped rather than rendered
 * as a broken image - a referenced screenshot is not the same thing as a
 * screenshot, and part A proved that gap is real.
 */
function screenshotMarkdown(finding: { evidence: { screenshots: string[] } }): string[] {
  return finding.evidence.screenshots
    .map((path) => shotUrls.get(shotBasename(path)))
    .filter((url): url is string => Boolean(url))
    .map((url) => `![screenshot](${url})`);
}

function commentBody(action: Extract<Action, { kind: 'comment' }>): string {
  const head = action.reopened
    ? `Reproduced again on ${report.run.date}, after this issue was closed.`
    : `Seen again on ${report.run.date}.`;
  const escalation = action.escalateTo
    ? `\n\nSeverity raised to **${action.escalateTo}**: this run reached a worse manifestation than the one on record.`
    : '';
  return (
    `${head} Persona **${report.run.persona}**, focus **${report.run.focus}**.` +
    escalation +
    `\n\n**Observed:** ${action.finding.observed}` +
    (action.finding.evidence.network ? `\n\n**Network:** ${action.finding.evidence.network}` : '') +
    // The images go last, after the network line, so the prose still reads
    // straight through on an issue that has accumulated several nights of them.
    (screenshotMarkdown(action.finding).length > 0
      ? `\n\n${screenshotMarkdown(action.finding).join('\n\n')}`
      : '')
  );
}

for (const action of actions) {
  if (action.kind === 'skip') {
    lines.push(`- **skipped** ${action.finding.title} — ${action.reason}`);
    continue;
  }

  if (action.kind === 'comment') {
    gh(['issue', 'comment', String(action.issue), '--body', commentBody(action)]);
    if (action.escalateTo) {
      const previous = known.find((i) => i.number === action.issue)?.severity;
      if (previous) gh(['issue', 'edit', String(action.issue), '--remove-label', previous]);
      gh(['issue', 'edit', String(action.issue), '--add-label', action.escalateTo]);
    }
    lines.push(
      `- **commented on #${action.issue}** ${action.finding.title}` +
        (action.escalateTo ? ` _(severity raised to ${action.escalateTo})_` : '') +
        (action.reopened ? ' _(reproduced after close)_' : ''),
    );
    continue;
  }

  const labels = ['nightly-qa', action.finding.severity];
  if (action.possibleDuplicateOf.length > 0) labels.push('possible-duplicate');
  const shots = screenshotMarkdown(action.finding);
  let body = renderIssueBody(action.finding, report.run).replace(
    '<!-- screenshots -->',
    shots.length > 0 ? `**Screenshots**\n\n${shots.join('\n\n')}` : '',
  );
  if (action.possibleDuplicateOf.length > 0) {
    body +=
      `\n> The same fingerprint is already open on ` +
      action.possibleDuplicateOf.map((n) => `#${n}`).join(', ') +
      `. The agent judged this a separate problem; worth a human confirming.\n`;
  }
  const out = gh([
    'issue',
    'create',
    '--title',
    `[nightly-qa] ${action.finding.title}`,
    '--label',
    labels.join(','),
    '--body',
    body,
  ]);
  lines.push(`- **created** ${action.finding.title} ${out.trim()}`);
}

for (const drop of dropped) lines.push(`- **dropped** finding ${drop.id} — ${drop.reason}`);

if (neighbours.length > 0) {
  lines.push('', '## Neighbours, for a human to glance at', '');
  for (const n of neighbours) {
    lines.push(`- finding \`${n.finding}\` shares \`${n.shared}\` with #${n.issue}, but is not the same symptom`);
  }
}

if (report.notes) lines.push('', '## What the agent could not reach', '', report.notes);

const summary = lines.join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
}
