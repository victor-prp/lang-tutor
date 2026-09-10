/**
 * Scores the real prompt against the real model. Runs in CI as the `test-eval`
 * job, so a prompt regression surfaces at the commit that caused it — at the
 * cost of the one failure mode no other job has: a provider's model update can
 * turn this red with nothing in the diff to blame. Read the scorecard before
 * reading the diff.
 *
 * A standalone tsx script rather than a third Jest project, for two reasons: a
 * Jest project sits one --selectProjects mistake away from being swept into
 * `npm test`, which must make no network call at all (ADR 0004 R4), and
 * pass/fail per case is the wrong output — what a prompt change needs is a
 * scorecard.
 *
 * It exercises the real artifact: the same prompt builder, parser and provider
 * production uses. Only the base URL differs from a normal run. It deliberately
 * does not go through HTTP — the object under test is the prompt, and booting a
 * server and a database would add nothing to the loop around it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadGeminiConfig } from '../../src/config';
import { createGeminiClient } from '../../src/providers/gemini';
import { askModel, type ModelAnswer } from './askModel';
import { CASES, type EvalCase } from './cases';

const TIER2_THRESHOLD = 0.85;
const TIMEOUT_MS = 30_000;
const HEBREW = /[֐-׿]/;

/**
 * Cases run concurrently, not in parallel: each one is a single HTTP call this
 * script spends seconds waiting on, so one event loop with several requests in
 * flight is the whole win — worker threads would add process overhead to work
 * that is never on the CPU.
 *
 * Bounded rather than a bare Promise.all over every case. `providers/gemini.ts`
 * has no retry by design, so a burst that trips a per-minute quota returns 429,
 * which surfaces here as a tier 1 failure that says nothing about the prompt.
 * Four is comfortable on a modest quota; raise it with EVAL_CONCURRENCY, and
 * lower it to 1 if a run reports `responded 429`.
 */
const CONCURRENCY = Math.max(1, Number(process.env.EVAL_CONCURRENCY) || 4);

type Check = { name: string; ok: boolean; detail?: string };

type Row = {
  label: string;
  text: string;
  tier1: Check[];
  tier2: Check[];
  result?: ModelAnswer;
  error?: string;
};

/**
 * A fixed pool of `limit` workers pulling from one shared cursor, rather than a
 * Promise.all over every case at once — see CONCURRENCY above for why the fan-out
 * is bounded.
 *
 * Results are written by index and never pushed. Responses come back in whatever
 * order the model answers, but the scorecard has to print in CASES order or two
 * runs cannot be diffed against each other, which is the whole point of keeping
 * the reports.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let index = cursor++; index < items.length; index = cursor++) {
        results[index] = await run(items[index]);
      }
    }),
  );

  return results;
}

function tier1(kase: EvalCase, result: ModelAnswer): Check[] {
  const checks: Check[] = [];
  const senses = result.senses;

  checks.push({
    name: 'at most 5 senses',
    ok: senses.length <= 5,
    detail: `${senses.length}`,
  });

  if (kase.expectEmpty) {
    checks.push({ name: 'no senses', ok: senses.length === 0, detail: `${senses.length}` });
    checks.push({
      name: 'no entries',
      ok: result.entries.length === 0,
      detail: `${result.entries.length}`,
    });
    return checks;
  }

  checks.push({ name: 'at least one sense', ok: senses.length >= 1 });
  if (senses.length === 0) return checks;

  checks.push({
    name: 'at least one entry',
    ok: result.entries.length >= 1,
    detail: `${result.entries.length}`,
  });
  // The schema already requires a non-empty lemma and sense_code, so this is
  // not a restatement of it: it catches a whitespace lemma, a sense_code that
  // is prose rather than a code, and two senses of one headword sharing a code
  // — all of which parse and all of which make a row unreadable in psql.
  checks.push({
    name: "every entry has a real lemma and distinct snake_case sense codes",
    ok: result.entries.every(
      (entry) =>
        entry.lemma.trim().length > 0 &&
        entry.senses.every((sense) => /^[a-z0-9]+(_[a-z0-9]+)*$/.test(sense.sense_code)) &&
        new Set(entry.senses.map((sense) => sense.sense_code)).size === entry.senses.length,
    ),
    detail: result.entries
      .map((entry) => `${entry.lemma}: ${entry.senses.map((s) => s.sense_code).join(',')}`)
      .join(' | '),
  });

  if (result.direction === 'en_he') {
    checks.push({
      name: 'translation is in Hebrew script',
      ok: senses.every((sense) => HEBREW.test(sense.translation)),
    });
  }

  if (result.kind === 'sentence') {
    // The server enforces this, so a failure here means normalizeSenses broke,
    // not that the model misbehaved.
    checks.push({ name: 'a sentence has exactly one sense', ok: senses.length === 1 });
    checks.push({
      name: 'a sentence has no part_of_speech and no example',
      ok: senses.every((sense) => !sense.part_of_speech && !sense.example),
    });
  } else {
    checks.push({
      name: 'every sense has a part of speech',
      ok: senses.every((sense) => Boolean(sense.part_of_speech)),
    });
    checks.push({
      name: "every example names its entry's lemma or an inflection of it",
      // A stem check, not equality: "booked" and "running" must both count. It
      // is the *lemma* that is checked, not the queried string: senses belong
      // to the headword, so `saw`'s first entry carries `see`'s examples.
      ok: result.entries.every((entry) => {
        const stem = entry.lemma.trim().toLowerCase().slice(0, Math.max(4, entry.lemma.length - 3));
        return entry.senses.every((sense) => sense.example?.source.toLowerCase().includes(stem));
      }),
      detail: result.entries.map((entry) => entry.lemma).join(' | '),
    });
    checks.push({
      name: 'every example carries a non-empty translation',
      ok: senses.every((sense) => Boolean(sense.example?.target?.trim())),
    });
  }

  return checks;
}

function tier2(kase: EvalCase, result: ModelAnswer): Check[] {
  const checks: Check[] = [];
  const translations = result.senses.map((sense) => sense.translation);
  const contains = (needles: string[]) =>
    needles.some((needle) => translations.some((value) => value.includes(needle)));

  checks.push({
    name: `kind is ${kase.expectKind}`,
    ok: result.kind === kase.expectKind,
    detail: result.kind,
  });

  if (kase.expectEmpty) return checks;

  checks.push({
    name: 'top sense is in the accepted set',
    ok: kase.acceptTop.some((accepted) => translations[0]?.includes(accepted)),
    detail: translations[0],
  });

  if (kase.expectEntries !== undefined) {
    checks.push({
      name: `${kase.expectEntries} entr${kase.expectEntries === 1 ? 'y' : 'ies'}`,
      ok: result.entries.length === kase.expectEntries,
      detail: result.entries.map((entry) => entry.lemma).join(' | '),
    });
  }

  if (kase.expectEntrySenses !== undefined) {
    checks.push({
      name: `the first entry carries at least ${kase.expectEntrySenses} senses`,
      ok: (result.entries[0]?.senses.length ?? 0) >= kase.expectEntrySenses,
      detail: `${result.entries[0]?.senses.length ?? 0}`,
    });
  }

  if (kase.expectLemma) {
    checks.push({
      name: `the single entry's lemma is "${kase.expectLemma}"`,
      ok: result.entries[0]?.lemma.trim().toLowerCase() === kase.expectLemma,
      detail: result.entries[0]?.lemma,
    });
  }

  if (kase.expectAlso) {
    checks.push({
      name: 'an expected additional sense is present',
      ok: contains(kase.expectAlso),
      detail: translations.join(' | '),
    });
  }

  if (kase.rejectAny) {
    checks.push({
      name: 'no literal rendering of the idiom',
      ok: !contains(kase.rejectAny),
      detail: translations.join(' | '),
    });
  }

  return checks;
}

async function main(): Promise<void> {
  // Exits non-zero with a clear message rather than skipping quietly: a green
  // "0 cases ran" is the one outcome worse than a red suite.
  const gemini = loadGeminiConfig(process.env);
  if (gemini.baseUrl.includes('localhost') || gemini.baseUrl.includes('127.0.0.1')) {
    throw new Error(
      `GEMINI_BASE_URL points at ${gemini.baseUrl}. The eval bucket must call the real API; ` +
        'unset it to use the default.',
    );
  }

  const llm = createGeminiClient({
    fetch: globalThis.fetch,
    baseUrl: gemini.baseUrl,
    apiKey: gemini.apiKey,
    model: gemini.model,
    timeoutMs: TIMEOUT_MS,
  });

  // One case, scored. Every failure is caught and becomes a tier 1 row rather
  // than rejecting: one case that cannot reach the model must not abandon the
  // other nine, and with several requests in flight an escaping rejection would
  // take the run down mid-flight.
  const scoreCase = async (kase: EvalCase): Promise<Row> => {
    try {
      const result = await askModel(
        llm,
        kase.direction ? { text: kase.text, direction: kase.direction } : { text: kase.text },
      );
      return {
        label: kase.label,
        text: kase.text,
        tier1: tier1(kase, result),
        tier2: tier2(kase, result),
        result,
      };
    } catch (error) {
      return {
        label: kase.label,
        text: kase.text,
        tier1: [{ name: 'the call succeeded', ok: false, detail: (error as Error).message }],
        tier2: [],
        error: (error as Error).message,
      };
    }
  };

  const started = Date.now();
  const rows = await mapWithConcurrency(CASES, CONCURRENCY, scoreCase);
  const elapsedMs = Date.now() - started;

  // Scorecard. Every case prints its actual output, so a drop is diagnosable
  // rather than merely red.
  let tier1Failures = 0;
  let tier2Passed = 0;
  let tier2Total = 0;

  for (const row of rows) {
    const t1Bad = row.tier1.filter((check) => !check.ok);
    const t2Bad = row.tier2.filter((check) => !check.ok);
    tier1Failures += t1Bad.length;
    tier2Passed += row.tier2.filter((check) => check.ok).length;
    tier2Total += row.tier2.length;

    const mark = t1Bad.length > 0 ? 'FAIL' : t2Bad.length > 0 ? 'warn' : 'ok  ';
    console.log(`\n[${mark}] ${row.text} — ${row.label}`);
    if (row.result) {
      console.log(
        `       kind=${row.result.kind} direction=${row.result.direction} ` +
          `senses=${row.result.senses.map((sense) => sense.translation).join(' | ') || '(none)'}`,
      );
    }
    for (const check of [...t1Bad, ...t2Bad]) {
      console.log(
        `       ${t1Bad.includes(check) ? 'T1' : 'T2'} ${check.name}: ${check.detail ?? ''}`,
      );
    }
  }

  const score = tier2Total === 0 ? 0 : tier2Passed / tier2Total;
  console.log(
    `\ntier 1: ${tier1Failures} failure(s) (must be 0)\n` +
      `tier 2: ${tier2Passed}/${tier2Total} = ${(score * 100).toFixed(1)}% ` +
      `(threshold ${(TIER2_THRESHOLD * 100).toFixed(0)}%)\n` +
      `${CASES.length} cases in ${(elapsedMs / 1000).toFixed(1)}s ` +
      `at concurrency ${CONCURRENCY}`,
  );

  // Gitignored, so a prompt change can be diffed against the previous run
  // instead of judged from memory.
  const dir = join(__dirname, '.results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ model: gemini.model, score, rows }, null, 2));
  console.log(`report: ${file}`);

  if (tier1Failures > 0 || score < TIER2_THRESHOLD) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
