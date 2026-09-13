#!/usr/bin/env node
// Builds a words-1000.csv-shaped CSV of common English phrases (idioms,
// phrasal verbs, fixed multi-word expressions), sourced from the English
// Wiktionary category API (en.wiktionary.org), not from raw corpus frequency.
//
// Source verified live before writing this script: the MediaWiki API's
// `list=categorymembers` action against categories like "English idioms"
// returns page titles that are themselves the phrase headwords, already
// curated by Wiktionary editors as real multi-word dictionary entries —
// no separate frequency-ranked phrase corpus is fetchable in bulk the way
// SUBTLEX is for single words (Google Ngrams has no small mirror; the
// Kaikki/Wiktextract full dump is 2.6GB compressed and would need streaming
// decompression + parsing to extract the same information this API gives
// directly).
//
// Because these come from a curated category rather than a frequency
// corpus, there is no rank/count to sort by — output order is whatever the
// API returns (alphabetical per category, categories concatenated in the
// order given).
//
// Usage:
//   node scripts/backfill-cost-estimate/generate-phrases-csv.mjs --count 2000
//
// Options:
//   --count N         how many phrases to keep after filtering (default: all that survive)
//   --out PATH        output CSV path (default: phrases-<count>.csv next to this script)
//   --categories LIST comma-separated Wiktionary category names, without the
//                     "Category:" prefix (default: "English idioms,English phrasal verbs,
//                     English multiword terms,English proverbs")

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_BASE = 'https://en.wiktionary.org/w/api.php';
const USER_AGENT = 'lang-tutor-init-backfill-script/1.0 (offline vocabulary backfill research)';

// "English multiword terms" was tried and dropped: verified live at 224,925
// entries — it's every multi-word title (compounds, species binomials,
// place names, etc.), not a curated idiom/phrase category, and swamps the
// signal from the three below.
const DEFAULT_CATEGORIES = [
  'English idioms',
  'English phrasal verbs',
  'English proverbs',
];

// Same phrase entries already seeded in db/content.generated.ts, kept in
// sync by hand with the SEEDED set in generate-words-csv.mjs — querying
// them again would just be a guaranteed, uninteresting cache hit.
const SEEDED = new Set([
  'to remember', 'excuse me', 'good morning', 'thank you very much',
  'How do you do?', 'see you later', 'Have a nice day!', 'Nice to meet you',
]);

function parseArgs(argv) {
  const args = { count: Infinity, categories: DEFAULT_CATEGORIES };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--count') args.count = Number(argv[++i]);
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--categories') args.categories = argv[++i].split(',').map((s) => s.trim());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.count || args.count < 1) {
    throw new Error('--count must be a positive number when given, e.g. --count 2000');
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The Wikimedia API's anonymous rate limit is shared across whatever egress
// IP the caller sits behind, so even a single well-behaved request can come
// back 429 if that IP has been busy — this is transient, not a block, and
// clears with a short backoff (verified live: a 429 followed a few seconds
// later by a 200 with no change in request shape).
async function fetchJsonWithRetry(url, { retries = 5, baseDelayMs = 2000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (response.status === 429 && attempt < retries) {
      const delay = baseDelayMs * 2 ** attempt;
      console.log(`  (429, retrying in ${delay}ms...)`);
      await sleep(delay);
      continue;
    }
    if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
    return response.json();
  }
}

async function fetchCategoryMembers(category) {
  const titles = [];
  let cmcontinue;
  do {
    const url = new URL(API_BASE);
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'categorymembers');
    url.searchParams.set('cmtitle', `Category:${category}`);
    url.searchParams.set('cmlimit', '500');
    url.searchParams.set('cmnamespace', '0'); // main namespace only, no subcategories/talk pages
    url.searchParams.set('format', 'json');
    if (cmcontinue) url.searchParams.set('cmcontinue', cmcontinue);

    const body = await fetchJsonWithRetry(url);
    if (body.error) throw new Error(`Wiktionary API error for "${category}": ${body.error.info}`);

    for (const member of body.query?.categorymembers ?? []) titles.push(member.title);
    cmcontinue = body.continue?.cmcontinue;
    if (cmcontinue) await sleep(300); // stay well under the rate limit between pages
  } while (cmcontinue);
  return titles;
}

function csvEscape(phrase) {
  return `"${phrase.replace(/"/g, '""')}"`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const countLabel = Number.isFinite(args.count) ? args.count : 'all';
  const outPath = args.out ?? join(__dirname, `phrases-${countLabel}.csv`);

  console.log(`Fetching category members for: ${args.categories.join(', ')}`);
  const raw = [];
  for (const category of args.categories) {
    const titles = await fetchCategoryMembers(category);
    console.log(`  "${category}": ${titles.length} entries`);
    for (const title of titles) raw.push(title); // not push(...titles): blows the call stack at this size
  }
  console.log(`Loaded ${raw.length} raw entries (before dedup/filtering).`);

  const seen = new Set();
  let droppedSingleWord = 0;
  let droppedTooLong = 0;
  let droppedNonAlpha = 0;
  let droppedSeeded = 0;
  let droppedDuplicate = 0;

  const kept = [];
  for (const title of raw) {
    const lower = title.toLowerCase();
    const wordCount = title.trim().split(/\s+/).length;
    if (wordCount < 2) { droppedSingleWord++; continue; }
    if (wordCount > 6 || title.length >= 100) { droppedTooLong++; continue; }
    // Real phrase headwords are letters, spaces, and ordinary punctuation
    // (apostrophes, hyphens, one trailing "?"/"!"); anything else is a
    // disambiguation-style title (e.g. "run (baseball)") or a stray artifact.
    if (!/^[A-Za-z][A-Za-z' -]*[A-Za-z?!]$/.test(title)) { droppedNonAlpha++; continue; }
    if (SEEDED.has(title) || SEEDED.has(lower)) { droppedSeeded++; continue; }
    if (seen.has(lower)) { droppedDuplicate++; continue; }
    seen.add(lower);
    kept.push(title);
    if (kept.length >= args.count) break;
  }

  if (Number.isFinite(args.count) && kept.length < args.count) {
    console.warn(
      `WARNING: only ${kept.length} phrases survived filtering, fewer than the ` +
        `requested ${args.count}. The source has ${raw.length} raw entries total.`,
    );
  }

  const csv = ['text', ...kept.map(csvEscape)].join('\n') + '\n';
  writeFileSync(outPath, csv);

  console.log(`\nDropped: ${droppedSingleWord} single-word, ${droppedTooLong} too long, ` +
    `${droppedNonAlpha} non-alphabetic/disambiguation, ${droppedSeeded} already seeded, ` +
    `${droppedDuplicate} case-insensitive duplicates.`);
  console.log(`Wrote ${kept.length} rows to ${outPath}`);
  console.log(`First 10: ${kept.slice(0, 10).join(', ')}`);
  console.log(`Last 10: ${kept.slice(-10).join(', ')}`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
