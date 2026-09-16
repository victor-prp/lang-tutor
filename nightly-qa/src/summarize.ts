import { readFileSync } from 'node:fs';

/**
 * Reads the stream-json transcript and prints what phase B needs to set its
 * caps: how many turns the session actually took, how long it ran, and what it
 * said at the end. The turn cap in the design is a placeholder until this has
 * been run for real.
 */

const path = process.argv[2];
if (!path) {
  console.error('usage: tsx nightly-qa/src/summarize.ts <transcript.jsonl>');
  process.exit(2);
}

let lines: string[];
try {
  lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
} catch {
  console.error(`No transcript at ${path}.`);
  process.exit(1);
}

const events = lines.flatMap((line) => {
  try {
    return [JSON.parse(line) as Record<string, unknown>];
  } catch {
    return [];
  }
});

const result = events.find((event) => event.type === 'result');
const messages = events.filter(
  (event) => event.type === 'assistant' || event.type === 'user',
).length;

console.log('--- session summary ---------------------------------------');
if (result) {
  console.log(`turns:         ${String(result.num_turns ?? 'unknown')}`);
  console.log(`duration:      ${String(result.duration_ms ?? 'unknown')} ms`);
  console.log(`subtype:       ${String(result.subtype ?? 'unknown')}`);
  if (result.usage) console.log(`usage:         ${JSON.stringify(result.usage)}`);
  if (result.total_cost_usd !== undefined) {
    console.log(`cost (api eq): ${String(result.total_cost_usd)}`);
  }
} else {
  console.log('no result event: the session did not finish cleanly');
}
console.log(`messages:      ${messages}`);
console.log('-----------------------------------------------------------');

if (result && result.subtype === 'error_max_turns') {
  console.error('The session hit the turn cap. Raise --max-turns or tighten the brief.');
  process.exit(1);
}
