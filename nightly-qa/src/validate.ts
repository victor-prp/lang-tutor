import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { checkScreenshots, parseReportLoose, severities, shotBasename } from './findings.ts';

const path = process.argv[2];
if (!path) {
  console.error('usage: tsx nightly-qa/src/validate.ts <findings.json>');
  process.exit(2);
}

let raw: string;
try {
  raw = readFileSync(path, 'utf8');
} catch {
  console.error(`No findings file at ${path}. The session wrote nothing.`);
  process.exit(1);
}

let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch (error) {
  console.error(`${path} is not valid JSON: ${(error as Error).message}`);
  console.error(raw.slice(0, 500));
  process.exit(1);
}

let report;
let dropped;
try {
  ({ report, dropped } = parseReportLoose(parsed));
} catch (error) {
  console.error(`${path} does not match the findings contract:`);
  console.error(error);
  process.exit(1);
}

if (!report.run.browser_ok) {
  console.error('The session reported browser_ok = false: it never drove the app.');
  process.exit(1);
}

for (const drop of dropped) {
  console.warn(`  dropped    finding ${drop.id}: ${drop.reason}`);
}

// Screenshot paths in a finding are relative to the findings file itself. The
// images are always flat in shots/, so a bare filename and a shots/-prefixed one
// name the same image - the first CI night produced the bare form for all four.
const base = dirname(resolve(path));
const { missing, unevidenced } = checkScreenshots(
  report,
  (p) => existsSync(resolve(base, 'shots', shotBasename(p))) || existsSync(resolve(base, p)),
);
for (const gap of missing) {
  console.warn(`  missing    finding ${gap.id} cites ${gap.path}, which is not on disk`);
}
if (unevidenced.length > 0) {
  console.error(
    `Findings whose only evidence was a screenshot that does not exist: ${unevidenced.join(', ')}.`,
  );
  process.exit(1);
}

const counts = severities.map(
  (s) => `${s}: ${report.findings.filter((f) => f.severity === s).length}`,
);
console.log(`  ok         ${report.findings.length} findings (${counts.join(', ')})`);
for (const finding of report.findings) {
  console.log(
    `             [${finding.severity}/${finding.confidence}] ${finding.screen} — ${finding.title}`,
  );
}
