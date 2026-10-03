import { readFileSync } from 'node:fs';

import { parseCategoriesFile } from './categories.ts';
import { compare, parseExamples, type Comparison } from './examples.ts';

/**
 * Grades a calibration run against the owner's decisions. The bar is the
 * spec's: no wrong closes, and at least 80% agreement. rules.md cites some
 * issues as examples, which leaks their answers; --rules reports the score
 * without them too, so the leak is visible rather than flattering.
 */

const BAR = 0.8;

const args = process.argv.slice(2);
const [csvPath, categoriesPath] = args;
const rulesIndex = args.indexOf('--rules');
const rulesPath = rulesIndex === -1 ? undefined : args[rulesIndex + 1];
if (!csvPath || !categoriesPath) {
  console.error('usage: tsx nightly-qa/src/calibrate.ts <examples.csv> <categories.json> [--rules <rules.md>]');
  process.exit(2);
}

const parsed = parseCategoriesFile(readFileSync(categoriesPath, 'utf8'));
if (!parsed.ok) {
  console.error(parsed.error);
  process.exit(1);
}
const rows = parseExamples(readFileSync(csvPath, 'utf8'));

function print(label: string, c: Comparison): void {
  const pct = c.total === 0 ? 0 : Math.round((100 * c.agreed) / c.total);
  console.log(`\n## ${label}\n`);
  console.log(`Agreement: ${c.agreed}/${c.total} (${pct}%)`);
  console.log(`Wrong closes: ${c.wrongCloses.length === 0 ? 'none' : c.wrongCloses.map((n) => `#${n}`).join(', ')}`);
  if (c.missing.length > 0) console.log(`Missing: ${c.missing.map((n) => `#${n}`).join(', ')}`);
  for (const d of c.disagreements) console.log(`- #${d.issue}: owner ${d.expected}, model ${d.got}`);
}

const overall = compare(rows, parsed.file.decisions);
print('All decided issues', overall);

if (rulesPath) {
  const cited = new Set([...readFileSync(rulesPath, 'utf8').matchAll(/#(\d+)/g)].map((m) => Number(m[1])));
  print(`Excluding the ${cited.size} issues rules.md cites`, compare(rows, parsed.file.decisions, cited));
}

const passed = overall.wrongCloses.length === 0 && overall.total > 0 && overall.agreed / overall.total >= BAR;
console.log(`\n${passed ? 'PASS' : 'FAIL'}: bar is zero wrong closes and ${BAR * 100}% agreement.`);
process.exit(passed ? 0 : 1);
