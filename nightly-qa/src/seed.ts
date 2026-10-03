import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseExamples, toSeedDecisions } from './examples.ts';
import { fetchTracker } from './gh.ts';
import { isOpen, trackerSchema, type Meta } from './targets.ts';

/**
 * One-off. Writes the owner's hand-made decisions as a categories.json and the
 * files apply.ts reads beside it, so the backlog goes through exactly the code
 * a night does. Run apply.ts on the result twice: once to read, once --apply.
 */

const [csvPath, outDir] = process.argv.slice(2);
if (!csvPath || !outDir) {
  console.error('usage: tsx nightly-qa/src/seed.ts <examples.csv> <outDir>');
  process.exit(2);
}

const tracker = trackerSchema.parse(fetchTracker());
const open = new Set(tracker.filter(isOpen).map((i) => i.number));
const all = toSeedDecisions(parseExamples(readFileSync(csvPath, 'utf8')));
const decisions = all.filter((d) => open.has(d.issue));
for (const d of all.filter((d) => !open.has(d.issue))) {
  console.error(`  skip       #${d.issue} is closed on the tracker; a close is final`);
}

const meta: Meta = {
  date: new Date().toISOString().slice(0, 10),
  targets: decisions.map((d) => d.issue).sort((a, b) => a - b),
  carried: [],
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'known.json'), JSON.stringify(tracker, null, 2) + '\n');
writeFileSync(join(outDir, 'categories.json'), JSON.stringify({ decisions, rule_gaps: [] }, null, 2) + '\n');
writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

console.error(`  ok         ${decisions.length} decisions. Next: npx tsx nightly-qa/src/apply.ts ${outDir}`);
