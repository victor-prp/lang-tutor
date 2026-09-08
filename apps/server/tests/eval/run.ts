/**
 * Scores the real prompt against the real model. A signal, never a gate: a
 * model update can turn this red with no change to this repository, so it does
 * not run on pull requests and is not a required check.
 *
 * A standalone tsx script rather than a third Jest project, for two reasons: a
 * Jest project sits one --selectProjects mistake away from being swept into CI,
 * and pass/fail per case is the wrong output — what a prompt change needs is a
 * scorecard.
 *
 * It exercises the real artifact: the same prompt builder, parser and provider
 * production uses. Only the base URL differs from a normal run. It deliberately
 * does not go through HTTP — the object under test is the prompt, and booting a
 * server and a database would add nothing to the loop around it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TranslationResponse } from '@lang-tutor/core/api';

import { loadGeminiConfig } from '../../src/config';
import { createGeminiClient } from '../../src/providers/gemini';
import { createTranslationService } from '../../src/services/translations';
import { CASES, type EvalCase } from './cases';

const TIER2_THRESHOLD = 0.85;
const TIMEOUT_MS = 30_000;
const HEBREW = /[֐-׿]/;

type Check = { name: string; ok: boolean; detail?: string };

function tier1(kase: EvalCase, result: TranslationResponse): Check[] {
  const checks: Check[] = [];
  const senses = result.senses;

  checks.push({
    name: 'at most 5 senses',
    ok: senses.length <= 5,
    detail: `${senses.length}`,
  });

  if (kase.expectEmpty) {
    checks.push({ name: 'no senses', ok: senses.length === 0, detail: `${senses.length}` });
    return checks;
  }

  checks.push({ name: 'at least one sense', ok: senses.length >= 1 });
  if (senses.length === 0) return checks;

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
      name: 'every example names the queried term or an inflection of it',
      // A stem check, not equality: "booked" and "running" must both count.
      ok: senses.every((sense) => {
        if (!sense.example) return false;
        const stem = kase.text.trim().toLowerCase().slice(0, Math.max(4, kase.text.length - 3));
        return sense.example.source.toLowerCase().includes(stem);
      }),
    });
    checks.push({
      name: 'every example carries a non-empty translation',
      ok: senses.every((sense) => Boolean(sense.example?.target?.trim())),
    });
  }

  return checks;
}

function tier2(kase: EvalCase, result: TranslationResponse): Check[] {
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
  const service = createTranslationService({
    llm,
    logger: { info: () => {}, error: () => {} },
  });

  const rows: {
    label: string;
    text: string;
    tier1: Check[];
    tier2: Check[];
    result?: TranslationResponse;
    error?: string;
  }[] = [];

  for (const kase of CASES) {
    try {
      const result = await service.translate(
        kase.direction ? { text: kase.text, direction: kase.direction } : { text: kase.text },
      );
      rows.push({
        label: kase.label,
        text: kase.text,
        tier1: tier1(kase, result),
        tier2: tier2(kase, result),
        result,
      });
    } catch (error) {
      rows.push({
        label: kase.label,
        text: kase.text,
        tier1: [{ name: 'the call succeeded', ok: false, detail: (error as Error).message }],
        tier2: [],
        error: (error as Error).message,
      });
    }
  }

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
      `(threshold ${(TIER2_THRESHOLD * 100).toFixed(0)}%)`,
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
