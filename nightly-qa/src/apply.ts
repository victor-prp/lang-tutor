import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { checkDecisions, parseCategoriesFile } from './categories.ts';
import { issueNumberFromUrl, knownIssuesSchema } from './knownIssues.ts';
import { renderReport, reportTitle } from './report.ts';
import { metaSchema, REPORT_LABEL } from './targets.ts';
import { labelCommands, planChanges } from './triage.ts';

/**
 * The apply job. Holds no model: it validates what the categoriser wrote,
 * derives every write from it in triage.ts, and runs them. Without --apply it
 * prints them instead, exactly like file.ts.
 */

const OWNER = 'victor-prp';

const [dir, ...flags] = process.argv.slice(2);
const apply = flags.includes('--apply');
if (!dir) {
  console.error('usage: tsx nightly-qa/src/apply.ts <triageDir> [--apply]');
  process.exit(2);
}

const readJson = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), 'utf8'));

function gh(args: string[]): string {
  if (!apply) {
    console.log(`  would run: gh ${args.map((a) => (/[\s"'|#]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    return '';
  }
  return execFileSync('gh', args, { encoding: 'utf8' });
}

function summarise(text: string): void {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
}

const meta = metaSchema.parse(readJson('meta.json'));
if (meta.targets.length === 0) {
  summarise(`# Nightly triage — ${meta.date}\n\nNothing to categorise tonight.`);
  process.exit(0);
}

const categoriesPath = join(dir, 'categories.json');
const parsed = parseCategoriesFile(existsSync(categoriesPath) ? readFileSync(categoriesPath, 'utf8') : null);
if (!parsed.ok) {
  console.error(parsed.error);
  process.exit(1);
}

const known = knownIssuesSchema.parse(readJson('known.json'));
const checked = checkDecisions(parsed.file, meta.targets, known);
const changes = planChanges(checked.accepted, known);

// A label that cannot be created will fail every change after it, so that one
// is fatal. A single change failing is not: the rest still apply, the report
// still says what happened, and the job still goes red at the end.
for (const command of labelCommands()) gh(command);
const failures = new Map<number, string>();
for (const change of changes) {
  try {
    for (const command of change.commands) gh(command);
  } catch (error) {
    const message = ((error as { stderr?: string }).stderr || (error as Error).message).trim().split('\n')[0];
    failures.set(change.decision.issue, message);
    console.error(`  !!         #${change.decision.issue}: ${message}`);
  }
}

const runUrl =
  process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;

const body = renderReport({
  date: meta.date,
  runUrl,
  checked,
  changes,
  ruleGaps: parsed.file.rule_gaps,
  carried: meta.carried,
  failures,
  titles: new Map(known.map((issue) => [issue.number, issue.title])),
});

// Read the open reports before filing tonight's, so tonight's is never in the list.
const previous = apply
  ? z
      .array(z.object({ number: z.number() }))
      .parse(JSON.parse(gh(['issue', 'list', '--label', REPORT_LABEL, '--state', 'open', '--json', 'number'])))
  : [];

const created = gh([
  'issue', 'create',
  '--title', reportTitle(meta.date),
  '--label', REPORT_LABEL,
  '--assignee', OWNER,
  '--body', body,
]);
const reportNumber = issueNumberFromUrl(created);
for (const p of previous) {
  gh(['issue', 'close', String(p.number), '--comment', reportNumber ? `Superseded by #${reportNumber}.` : 'Superseded.']);
}

summarise(`# Nightly triage — ${meta.date}\n\n${body}`);
if (failures.size > 0) process.exit(1);
