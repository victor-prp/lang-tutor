import { readFileSync } from 'node:fs';

import { parseReport, severities } from './findings.ts';

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
try {
  report = parseReport(parsed);
} catch (error) {
  console.error(`${path} does not match the findings contract:`);
  console.error(error);
  process.exit(1);
}

if (!report.run.browser_ok) {
  console.error('The session reported browser_ok = false: it never drove the app.');
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
