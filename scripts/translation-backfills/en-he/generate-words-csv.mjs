#!/usr/bin/env node
// Builds a words-1000.csv-shaped CSV from real SUBTLEX-US frequency data
// (Brysbaert et al.; 74,286 English word-forms ranked by frequency in film/TV
// subtitles). Source verified live before writing this script: fetched from
// https://github.com/words/subtlex-word-frequencies, which mirrors the
// Ghent University dataset as a flat JSON array of { word, count }, already
// sorted by frequency descending.
//
// SUBTLEX-US is word-form frequency, not lemma frequency — "run", "runs" and
// "running" are separate entries with their own counts, which is why the
// output here also has one row per surface form rather than per headword.
//
// Usage:
//   node scripts/translation-backfills/en-he/generate-words-csv.mjs --count 5000
//
// Options:
//   --count N     how many words to keep after filtering (default: all that survive)
//   --out PATH    output CSV path (default: words-<count>.csv next to this script)
//   --source URL  override the source JSON URL or a local file path

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE =
  'https://raw.githubusercontent.com/words/subtlex-word-frequencies/master/index.json';

// Already excluded from the backfill query pool because they're already in
// the dictionary from db/content.generated.ts — querying them again would
// just be a guaranteed, uninteresting cache hit.
const SEEDED = new Set([
  'window', 'book', 'water', 'friend', 'difficult',
  'to remember', 'excuse me', 'good morning', 'thank you very much',
  'How do you do?', 'see you later', 'Have a nice day!', 'Nice to meet you',
]);

// SUBTLEX-US is built from subtitle transcripts, and subtitle tokenizers
// split contractions ("don't" -> "do" + "n't"). The fragment half of each
// split shows up as a very high-frequency "word" — verified directly against
// the live data before writing this list: "s" ranks #4 (from "it's"/"let's"),
// "t" ranks #7 (from "don't"), "m" ranks #21 (from "I'm"), etc. None of these
// are things a learner would ever look up, so they're excluded by name rather
// than by a length rule alone (a length>=2 filter alone still lets "re", "ll",
// "nt", "em", "na", "ta" through — each independently verified present in the
// live data at length 2+).
const CONTRACTION_FRAGMENTS = new Set([
  's', 't', 'd', 'm', 're', 've', 'll', 'nt', 'em', 'na', 'ta', 'aint',
]);

// Informal spoken contractions that are real, common spoken forms but not
// standard dictionary headwords ("gonna" = "going to"). Verified present at
// high rank (gonna #80, wanna #226, gotta #225). Excluded so the model isn't
// asked to produce a formal dictionary entry for a colloquial spelling — a
// permanent, oddly-shaped entry is worse than not having one.
const INFORMAL_CONTRACTIONS = new Set([
  'gonna', 'wanna', 'gotta', 'kinda', 'sorta', 'hafta', 'lemme', 'gimme',
]);

function parseArgs(argv) {
  const args = { source: DEFAULT_SOURCE, count: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--count') args.count = Number(argv[++i]);
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--source') args.source = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.count || args.count < 1) {
    throw new Error('--count must be a positive number when given, e.g. --count 5000');
  }
  return args;
}

async function loadEntries(source) {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Failed to fetch ${source}: ${response.status}`);
    return response.json();
  }
  const { readFileSync } = await import('node:fs');
  return JSON.parse(readFileSync(source, 'utf8'));
}

function csvEscape(word) {
  return `"${word.replace(/"/g, '""')}"`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const countLabel = Number.isFinite(args.count) ? args.count : 'all';
  const outPath = args.out ?? join(__dirname, `words-${countLabel}.csv`);

  console.log(`Loading SUBTLEX-US data from ${args.source}...`);
  const entries = await loadEntries(args.source);
  console.log(`Loaded ${entries.length} raw entries.`);

  const seen = new Set();
  let droppedShort = 0;
  let droppedFragment = 0;
  let droppedInformal = 0;
  let droppedSeeded = 0;
  let droppedDuplicate = 0;

  const kept = [];
  for (const { word } of entries.sort((a, b) => b.count - a.count)) {
    const lower = word.toLowerCase();
    if (word.length < 2) { droppedShort++; continue; }
    if (CONTRACTION_FRAGMENTS.has(lower)) { droppedFragment++; continue; }
    if (INFORMAL_CONTRACTIONS.has(lower)) { droppedInformal++; continue; }
    if (SEEDED.has(word) || SEEDED.has(lower)) { droppedSeeded++; continue; }
    if (seen.has(lower)) { droppedDuplicate++; continue; }
    seen.add(lower);
    kept.push(word);
    if (kept.length >= args.count) break;
  }

  if (Number.isFinite(args.count) && kept.length < args.count) {
    console.warn(
      `WARNING: only ${kept.length} words survived filtering, fewer than the ` +
        `requested ${args.count}. The source has ${entries.length} entries total.`,
    );
  }

  const csv = ['text', ...kept.map(csvEscape)].join('\n') + '\n';
  writeFileSync(outPath, csv);

  console.log(`\nDropped: ${droppedShort} too short, ${droppedFragment} contraction ` +
    `fragments, ${droppedInformal} informal contractions, ${droppedSeeded} already ` +
    `seeded, ${droppedDuplicate} case-insensitive duplicates.`);
  console.log(`Wrote ${kept.length} rows to ${outPath}`);
  console.log(`First 10: ${kept.slice(0, 10).join(', ')}`);
  console.log(`Last 10: ${kept.slice(-10).join(', ')}`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
