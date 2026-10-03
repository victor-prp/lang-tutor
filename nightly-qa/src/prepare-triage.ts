import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseExamples, toSeedDecisions } from './examples.ts';
import { fetchTracker, recentCommits } from './gh.ts';
import {
  filedSchema,
  isOpen,
  selectTargets,
  stripTriage,
  trackerSchema,
  type Meta,
  type TrackerIssue,
} from './targets.ts';

/**
 * Everything the categoriser session reads, written before it starts. The
 * session has no Bash and no gh, so what is not in these files does not exist
 * for it - which is the point.
 */

const CAP = 15;
const COMMITS = 300;

const args = process.argv.slice(2);
const outDir = args[0];
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
if (!outDir) {
  console.error('usage: tsx nightly-qa/src/prepare-triage.ts <outDir> [--filed <filed.json>] [--calibrate <examples.csv>]');
  process.exit(2);
}
const filedPath = flag('--filed');
const calibrate = flag('--calibrate');

const tracker = trackerSchema.parse(fetchTracker());
let known = tracker;
let targets: TrackerIssue[];
let carried: number[] = [];

if (calibrate) {
  // Every issue the owner decided that is still open, with the answers removed.
  // No cap: calibration is run by hand, once, and its value is the whole set.
  const decided = new Set(toSeedDecisions(parseExamples(readFileSync(calibrate, 'utf8'))).map((d) => d.issue));
  known = tracker.map(stripTriage);
  targets = known.filter((i) => isOpen(i) && decided.has(i.number)).sort((a, b) => a.number - b.number);
} else {
  // A missing filed.json is a local run or a night that filed nothing. Either
  // way the uncategorised issues are still worth a look.
  const filed =
    filedPath && existsSync(filedPath)
      ? filedSchema.parse(JSON.parse(readFileSync(filedPath, 'utf8')))
      : { created: [], commented: [] };
  ({ targets, carried } = selectTargets(tracker, filed, CAP));
}

const meta: Meta = {
  date: new Date().toISOString().slice(0, 10),
  targets: targets.map((i) => i.number),
  carried,
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'targets.json'), JSON.stringify(targets, null, 2) + '\n');
writeFileSync(join(outDir, 'known.json'), JSON.stringify(known, null, 2) + '\n');
writeFileSync(join(outDir, 'commits.txt'), recentCommits(COMMITS));
writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

console.error(
  `  ok         ${meta.targets.length} targets` +
    (carried.length > 0 ? `, ${carried.length} carried to the next night` : '') +
    (calibrate ? ' (calibration: answers stripped)' : ''),
);
