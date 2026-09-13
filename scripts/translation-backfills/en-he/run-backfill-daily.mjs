#!/usr/bin/env node
// The actual driver for a bulk backfill run (see run-backfill.mjs for the
// manual/small-batch tool this shares its request logic with). Gemini's
// daily quota (10K requests/day, see
// docs/superpowers/specs/2026-09-13-lang-tutor-phase-11-vocabulary-backfill-sourcing.md)
// means a full run always needs to stop partway and continue the next day —
// this script detects that itself instead of making you watch the log and
// slice a "remaining" CSV by hand.
//
// It stops as soon as it sees N consecutive failures (default 10) — that
// shape (a run of failures back to back, not occasional ones scattered
// through a mostly-successful run) is what a quota cutoff or provider outage
// looks like; isolated failures are left in place and simply retried in the
// next remaining-CSV, no special handling needed.
//
// On stop (or on reaching the end of --csv), it writes:
//   - <csv-basename>-remaining-<timestamp>.csv — every row that did not get
//     a 200 this run, in original order: rows that failed plus rows never
//     reached. Absent if every row succeeded.
//   - results-<timestamp>.jsonl — the full per-row record, same shape as
//     run-backfill.mjs's output.
// and prints a report: how many rows succeeded/failed, why it stopped, and
// the exact command to resume with the new remaining CSV.
//
// Usage:
//   node scripts/translation-backfills/en-he/run-backfill-daily.mjs --csv words-all.csv
//
// Options:
//   --csv PATH                    word/phrase list to read (required)
//   --max-words N                 cap on rows to read from the top of --csv (default: all)
//   --base-url URL                server base URL (default: http://localhost:3001/api)
//   --direction D                 'en_he' or 'he_en' (default: en_he)
//   --delay-ms N                  pause between requests (default: 10)
//   --max-consecutive-errors N    stop after this many failures in a row (default: 10)

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { loadWords, sleep, translateOne, writeCsv, timestampForFilename, ensureLogsDir } from './backfill-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    baseUrl: 'http://localhost:3001/api',
    direction: 'en_he',
    delayMs: 10,
    maxWords: Infinity,
    maxConsecutiveErrors: 10,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--max-words') args.maxWords = Number(argv[++i]);
    else if (arg === '--base-url') args.baseUrl = argv[++i];
    else if (arg === '--direction') args.direction = argv[++i];
    else if (arg === '--delay-ms') args.delayMs = Number(argv[++i]);
    else if (arg === '--csv') args.csv = argv[++i];
    else if (arg === '--max-consecutive-errors') args.maxConsecutiveErrors = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.csv) {
    throw new Error('--csv is required, e.g. --csv words-all.csv or --csv phrases-all.csv');
  }
  if (!args.maxConsecutiveErrors || args.maxConsecutiveErrors < 1) {
    throw new Error('--max-consecutive-errors must be a positive number when given');
  }
  return args;
}

// "words-all.csv" / "words-remaining-2026-09-13.csv" -> "words"; falls back
// to the full basename for a CSV that doesn't follow that naming.
function csvCategory(csvPath) {
  const stem = basename(csvPath).replace(/\.csv$/, '');
  return stem.split('-')[0] || stem;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const words = loadWords(args.csv, args.maxWords);

  console.log(`Backfilling ${words.length} rows from ${args.csv} against ${args.baseUrl}/translations`);
  console.log(
    `Direction: ${args.direction}. Delay: ${args.delayMs}ms. ` +
      `Stopping after ${args.maxConsecutiveErrors} consecutive failures.\n`,
  );

  const results = [];
  let consecutiveFailures = 0;
  let stopReason = null;
  const startedAt = Date.now();

  for (let i = 0; i < words.length; i++) {
    const text = words[i];
    const outcome = await translateOne({ text, baseUrl: args.baseUrl, direction: args.direction });
    const label = outcome.status === null ? 'NETWORK ERROR' : outcome.status;
    const summary = outcome.status === 200
      ? `kind=${outcome.kind} senses=${outcome.senseCount}`
      : `ERROR: ${outcome.error}`;
    console.log(`[${i + 1}/${words.length}] "${text}" -> ${label} in ${outcome.durationMs}ms (${summary})`);
    results.push(outcome);

    consecutiveFailures = outcome.status === 200 ? 0 : consecutiveFailures + 1;
    if (consecutiveFailures >= args.maxConsecutiveErrors) {
      stopReason = {
        type: 'consecutive-errors',
        count: consecutiveFailures,
        lastError: outcome.error ?? String(outcome.status),
      };
      console.log(
        `\nStopping: ${consecutiveFailures} failures in a row (last: "${text}" -> ${label}, ${stopReason.lastError}).`,
      );
      break;
    }

    if (args.delayMs > 0 && i < words.length - 1) await sleep(args.delayMs);
  }

  const totalMs = Date.now() - startedAt;
  const succeededTexts = new Set(results.filter((r) => r.status === 200).map((r) => r.text));
  const remaining = words.filter((text) => !succeededTexts.has(text));
  const succeededCount = words.length - remaining.length;

  const timestamp = timestampForFilename();
  const resultsPath = join(ensureLogsDir(__dirname), `results-${timestamp}.jsonl`);
  writeFileSync(resultsPath, results.map((r) => JSON.stringify(r)).join('\n') + '\n');

  let remainingPath = null;
  if (remaining.length > 0) {
    remainingPath = join(__dirname, `${csvCategory(args.csv)}-remaining-${timestamp}.csv`);
    writeCsv(remainingPath, remaining);
  }

  console.log('\n--- Report ---');
  console.log(`Attempted: ${results.length}/${words.length}`);
  console.log(`Succeeded: ${succeededCount}`);
  console.log(`Still needs backfill: ${remaining.length}`);
  console.log(`Wall-clock time: ${(totalMs / 1000).toFixed(1)}s`);
  console.log(
    stopReason
      ? `Stopped early: ${stopReason.count} consecutive failures (last error: ${stopReason.lastError}). ` +
        'This is the shape of a rate-limit cutoff or provider outage, not bad input rows.'
      : 'Reached the end of the input CSV without hitting the failure threshold.',
  );
  console.log(`Full per-row results: ${resultsPath}`);
  if (remainingPath) {
    console.log(`Remaining rows written to: ${remainingPath}`);
    console.log(
      `Resume with:\n  node ${basename(import.meta.url.replace('file://', ''))} --csv ${basename(remainingPath)}` +
        (Number.isFinite(args.maxWords) ? ` --max-words ${args.maxWords}` : ''),
    );
  } else {
    console.log('Nothing left to backfill from this file.');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
