// Shared pieces of the backfill request loop, used by both run-backfill.mjs
// (manual/small test runs) and run-backfill-daily.mjs (the guarded, resumable
// driver). Kept as one place so both callers hit /api/translations, parse the
// CSV, and format results identically.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function loadWords(csvPath, maxWords = Infinity) {
  const raw = readFileSync(csvPath, 'utf8').trim().split('\n');
  const [header, ...rows] = raw;
  if (header.trim() !== 'text') {
    throw new Error(`Expected CSV header "text", got "${header}"`);
  }
  const limited = Number.isFinite(maxWords) ? rows.slice(0, maxWords) : rows;
  return limited.map((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1).replace(/""/g, '"')
      : trimmed;
  });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function csvEscape(text) {
  return `"${text.replace(/"/g, '""')}"`;
}

export function writeCsv(path, rows) {
  const csv = ['text', ...rows.map(csvEscape)].join('\n') + '\n';
  writeFileSync(path, csv);
}

// Same timestamp shape run-backfill.mjs already uses for its results-*.jsonl
// files, reused here for the results file and the dated "remaining" CSV.
export function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Per-run results are logs, not inputs — kept out of git (see .gitignore)
// so a repeated backfill run doesn't pile up tracked jsonl files.
export function ensureLogsDir(scriptDir) {
  const dir = join(scriptDir, 'logs');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// The drivers' --direction flag predates phase 16, when the API took a
// `direction` field. It now takes `from` and `to` and answers 400 to anything
// else, so the flag is kept for the CLI and translated here, on the wire only.
const PAIRS = {
  en_he: { from: 'en', to: 'he' },
  he_en: { from: 'he', to: 'en' },
};

export function pairFor(direction) {
  const pair = PAIRS[direction];
  if (!pair) {
    throw new Error(
      `unknown --direction "${direction}"; expected ${Object.keys(PAIRS).join(' or ')}`,
    );
  }
  return pair;
}

// One POST + outcome record. No logging, no side effects beyond the network
// call, so callers can log/track it however they need. An unknown direction
// throws before any request rather than becoming one failed row per word.
export async function translateOne({ text, baseUrl, direction }) {
  const { from, to } = pairFor(direction);
  const requestStartedAt = Date.now();
  try {
    const response = await fetch(`${baseUrl}/translations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, from, to }),
    });
    const durationMs = Date.now() - requestStartedAt;
    const body = await response.json();
    return {
      text,
      status: response.status,
      durationMs,
      kind: body.kind,
      senseCount: Array.isArray(body.senses) ? body.senses.length : undefined,
      error: response.ok ? undefined : body.error,
    };
  } catch (error) {
    const durationMs = Date.now() - requestStartedAt;
    return { text, status: null, durationMs, error: String(error) };
  }
}
