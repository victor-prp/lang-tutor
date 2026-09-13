#!/usr/bin/env node
// Fires a batch of real translation lookups at a running server. Every
// lookup here is expected to be a cache miss and therefore a paid model
// call: this is meant to be run against real GEMINI_API_KEY, not MockServer.
// A cache miss on /api/translations runs the live model and persists the
// result (services/translations.ts -> persistEntries), so running this
// script against words-all.csv / phrases-all.csv *is* the bulk backfill,
// not just a cost measurement — see
// docs/superpowers/specs/2026-09-13-lang-tutor-phase-11-vocabulary-backfill-sourcing.md.
//
// This is the manual/small-batch tool (spot checks, cost samples). For an
// actual bulk run, use run-backfill-daily.mjs instead — it stops itself on a
// run of consecutive failures (rate limit, outage) and writes out exactly
// what's left to retry, which this script does not do.
//
// Usage:
//   node scripts/translation-backfills/en-he/run-backfill.mjs --csv words-all.csv --max-words 20
//
// Options:
//   --max-words N   how many rows to read from the top of --csv (required)
//   --base-url URL  server base URL (default: http://localhost:3001/api)
//   --direction D   'en_he' or 'he_en' (default: en_he)
//   --delay-ms N    pause between requests, to stay under a provider rate limit (default: 10)
//   --csv PATH      word/phrase list to read, e.g. words-all.csv or phrases-all.csv (required)
//
// Prints one line per lookup and a summary at the end. Writes the full
// results to a timestamped .jsonl file next to this script so you have a
// record of exactly what was asked when you go read the Gemini billing
// dashboard for the $ this batch actually cost.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadWords, sleep, translateOne, timestampForFilename, ensureLogsDir } from './backfill-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { baseUrl: 'http://localhost:3001/api', direction: 'en_he', delayMs: 10 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--max-words') args.maxWords = Number(argv[++i]);
    else if (arg === '--base-url') args.baseUrl = argv[++i];
    else if (arg === '--direction') args.direction = argv[++i];
    else if (arg === '--delay-ms') args.delayMs = Number(argv[++i]);
    else if (arg === '--csv') args.csv = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.maxWords || args.maxWords < 1) {
    throw new Error('--max-words is required, e.g. --max-words 20');
  }
  if (!args.csv) {
    throw new Error('--csv is required, e.g. --csv words-all.csv or --csv phrases-all.csv');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const words = loadWords(args.csv, args.maxWords);

  console.log(`Sampling ${words.length} lookups against ${args.baseUrl}/translations`);
  console.log(`Direction: ${args.direction}. Delay between requests: ${args.delayMs}ms.`);
  console.log(
    'Each of these is expected to be a cache miss and a real Gemini call — ' +
      'go watch https://aistudio.google.com/ (or your Cloud billing page) while this runs.\n',
  );

  const results = [];
  const startedAt = Date.now();

  for (let i = 0; i < words.length; i++) {
    const text = words[i];
    const outcome = await translateOne({ text, baseUrl: args.baseUrl, direction: args.direction });
    if (outcome.status === null) {
      console.log(
        `[${i + 1}/${words.length}] "${text}" -> NETWORK ERROR in ${outcome.durationMs}ms (${outcome.error})`,
      );
    } else {
      const summary = outcome.status === 200
        ? `kind=${outcome.kind} senses=${outcome.senseCount}`
        : `ERROR: ${outcome.error}`;
      console.log(
        `[${i + 1}/${words.length}] "${text}" -> ${outcome.status} in ${outcome.durationMs}ms (${summary})`,
      );
    }
    results.push(outcome);
    if (args.delayMs > 0 && i < words.length - 1) await sleep(args.delayMs);
  }

  const totalMs = Date.now() - startedAt;
  const succeeded = results.filter((r) => r.status === 200);
  const failed = results.filter((r) => r.status !== 200);
  const durations = succeeded.map((r) => r.durationMs);
  const avgMs = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;

  console.log('\n--- Summary ---');
  console.log(`Total requests: ${results.length}`);
  console.log(`Succeeded (200): ${succeeded.length}`);
  console.log(`Failed: ${failed.length}`);
  if (durations.length) {
    console.log(`Latency: avg=${avgMs}ms min=${Math.min(...durations)}ms max=${Math.max(...durations)}ms`);
  }
  console.log(`Wall-clock time: ${(totalMs / 1000).toFixed(1)}s`);

  const outPath = join(ensureLogsDir(__dirname), `results-${timestampForFilename()}.jsonl`);
  writeFileSync(outPath, results.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`\nFull results written to ${outPath}`);
  console.log(
    'Next: read the $ this batch cost from the Gemini billing/usage dashboard, divide by ' +
      `${succeeded.length} successful calls, and report both numbers back for the 100k estimate.`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
