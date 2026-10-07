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

import { PartOfSpeechSchema } from '@lang-tutor/core/api/schemas';

import { loadGeminiConfig } from '../../src/config';
import { normalizeForm } from '../../src/domain/dictionary';
import { comparable, distractorItems, validateDistractors, type Task } from '../../src/domain/distractors';
import { isInScript, stripStress } from '../../src/domain/languages';
import type { ReadItem } from '../../src/domain/photoReading';
import { createGeminiClient, createGeminiTranscriber, createGeminiVisionClient } from '../../src/providers/gemini';
import { judgeSpoken } from '@lang-tutor/core/domain';
import type { LlmDistractors, LlmReconciliation } from '@lang-tutor/core/api';

import { askDistractors, askJudge, askModel, askRendering, askTranscription, type ModelAnswer } from './askModel';
import {
  CASES,
  DISTRACTOR_CASES,
  JUDGE_CASES,
  RENDERING_CASES,
  TRANSCRIPTION_CASES,
  type DistractorCase,
  type EvalCase,
  type JudgeCase,
  type RenderingCase,
  type TranscriptionCase,
} from './cases';
import { askPhoto, askSenseMatch } from './askPhoto';
import { MATCH_CASES, PHOTO_CASES, type MatchCase, type PhotoCase } from './photoCases';

const TIER2_THRESHOLD = 0.85;
const TIMEOUT_MS = 30_000;
/** A photo read's production budget. */
const PHOTO_TIMEOUT_MS = 120_000;

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
  /** Set instead of `result` on a rendering row — the second call answers a
   *  different shape, and the scorecard prints whichever is present. */
  rendering?: LlmReconciliation;
  /** Set on a distractor row, the third call's answer. */
  distractors?: LlmDistractors;
  /** Set on a transcription row: what the model heard. */
  heard?: string;
  /** Set on a photo row: what the reading found. */
  photo?: ReadItem[];
  /** Set on a match row: the sense the model chose. */
  match?: number | 'none';
  /** Set on a judge row: the verdict received. */
  verdict?: string;
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

  // Phase 12: part_of_speech is half of dict_lexemes' unique key, so a value
  // outside the ten would not merely read oddly — it would make (book,"verb
  // phrase") a different lexeme from (book,"verb"). Gemini is handed the enum
  // inside responseSchema, so this should be unfailable; it is tier 1 exactly
  // because a provider that quietly stopped honouring responseSchema is the
  // kind of thing this bucket exists to notice.
  checks.push({
    name: 'every entry has a part of speech from the closed set',
    ok: result.entries.every((entry) => PartOfSpeechSchema.safeParse(entry.part_of_speech).success),
    detail: result.entries.map((entry) => entry.part_of_speech).join(', '),
  });

  checks.push({
    name: `translation is in ${result.to} script`,
    ok: senses.every((sense) => isInScript(sense.translation, result.to)),
  });

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
    // "Names its entry's lemma or an inflection of it" used to live here as a
    // stem check, but a stem check cannot work for English irregular
    // inflections: they share no stem with their lemma at all. A real run
    // failed two structurally-correct examples on exactly this —
    // lemma `see` / example "I saw him yesterday." (stem "see" is not in
    // "saw"), and lemma `light` / example "He lit a candle." (stem "ligh" is
    // not in "lit"). Tier 1 must be zero-failures, so a heuristic that can be
    // wrong about correct output cannot live here; it is scored as a tier 2
    // axis instead, below.
    checks.push({
      name: 'every example carries a non-empty source',
      // A companion to the translation check below, catching what the parse
      // schema's `min(1)` cannot: a whitespace-only source that satisfies
      // `z.string().min(1)` character-count-wise, the same class of gap the
      // lemma/sense_code check above closes for entries.
      ok: senses.every((sense) => Boolean(sense.example?.source?.trim())),
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

  if (kase.expectNoCorrection) {
    checks.push({
      name: 'reports no correction',
      ok: !result.correction,
      detail: result.correction?.corrected_form ?? 'none',
    });
  }

  if (kase.expectCorrection) {
    checks.push({
      name: `corrects to ${kase.expectCorrection}`,
      ok:
        result.correction?.corrected_form.toLowerCase() === kase.expectCorrection.toLowerCase(),
      detail: result.correction?.corrected_form ?? 'none',
    });
  }

  if (kase.expectAlternative) {
    checks.push({
      name: `offers ${kase.expectAlternative} as an alternative`,
      ok: (result.correction?.alternatives ?? []).some(
        (alternative) => alternative.toLowerCase() === kase.expectAlternative!.toLowerCase(),
      ),
      detail: (result.correction?.alternatives ?? []).join(', ') || 'none',
    });
  }

  if (kase.expectEmpty) return checks;

  checks.push({
    name: 'top sense is in the accepted set',
    ok: kase.acceptTop.some((accepted) => translations[0]?.includes(accepted)),
    detail: translations[0],
  });

  // Moved down from tier 1: see the comment there for why a stem check
  // cannot be a zero-failure invariant (English irregular inflections like
  // `see` -> "saw" or `light` -> "lit" share no stem with their lemma).
  // Scored here instead — an occasional miss on an irregular inflection
  // lowers this axis without failing the run, which is exactly the point of
  // tier 2 being scored rather than pass/fail. Sentences carry no examples
  // at all, so the axis does not apply to them.
  if (result.kind !== 'sentence') {
    checks.push({
      name: "every example illustrates its entry's lemma (word or an inflection of it)",
      // A stem check, not equality: "booked" and "running" must both count. It
      // is the *lemma* that is checked, not the queried string: senses belong
      // to the headword, so `saw`'s first entry carries `see`'s examples.
      ok: result.entries.every((entry) => {
        const stem = entry.lemma.trim().toLowerCase().slice(0, Math.max(4, entry.lemma.length - 3));
        return entry.senses.every((sense) => sense.example?.source.toLowerCase().includes(stem));
      }),
      detail: result.entries.map((entry) => entry.lemma).join(' | '),
    });
  }

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

  // The reading half of phase 12's defect: an inflected form must not bring back
  // an entry whose part of speech it does not realise.
  if (kase.expectEntryPos) {
    const offenders = result.entries
      .map((entry) => entry.part_of_speech)
      .filter((pos) => !kase.expectEntryPos!.includes(pos));
    checks.push({
      name: 'entry parts of speech',
      ok: offenders.length === 0,
      detail: offenders.length ? `unexpected: ${offenders.join(', ')}` : undefined,
    });
  }

  if (kase.expectPosOrder) {
    const actual = result.entries.map((entry) => entry.part_of_speech);
    checks.push({
      name: 'part of speech order',
      ok: JSON.stringify(actual) === JSON.stringify(kase.expectPosOrder),
      detail: `got ${actual.join(', ')}`,
    });
  }

  // Phase 12 follow-up, F2. Per part of speech, because entries[0] for an inflected form
  // is the verb and the defect lives on the adjective.
  if (kase.expectLemmaFor) {
    for (const [pos, lemma] of Object.entries(kase.expectLemmaFor)) {
      const matching = result.entries.filter((entry) => entry.part_of_speech === pos);
      checks.push({
        name: `the ${pos} entry's lemma is "${lemma}"`,
        // No entry of that part of speech is a failure too: the case asserts one
        // exists and names a particular lemma.
        ok:
          matching.length > 0 &&
          matching.every((entry) => entry.lemma.trim().toLowerCase() === lemma),
        detail: matching.length
          ? matching.map((entry) => entry.lemma).join(', ')
          : `no ${pos} entry`,
      });
    }
  }

  // Phase 12 follow-up. Scored against every sense's example, not only the top one: the
  // ambiguous sentence that prompted this rule sat at rank 1.
  if (kase.rejectExample) {
    const offenders = result.senses
      .map((sense) => sense.example?.source ?? '')
      .filter((source) =>
        kase.rejectExample!.some((rejected) =>
          source.toLowerCase().includes(rejected.toLowerCase()),
        ),
      );
    checks.push({
      name: 'no example we have already seen fail to disambiguate',
      ok: offenders.length === 0,
      detail: offenders.join(' | ') || undefined,
    });
  }

  // The rendering half: `booked` answering with an infinitive is the defect,
  // even though the infinitive is a perfectly good translation of `book`.
  if (kase.rejectTop) {
    const top = result.senses[0]?.translation ?? '';
    checks.push({
      name: 'top translation form',
      ok: !kase.rejectTop.some((rejected) => top.includes(rejected)),
      detail: `top was ${top}`,
    });
  }

  return checks;
}

/**
 * Invariants of a rendering answer: the things that must hold whatever the model
 * decides the form means. Mirrors `tier1` above, minus everything that belongs
 * to the entry split — a rendering answer has no entries and no `kind`.
 */
function renderingTier1(kase: RenderingCase, answer: LlmReconciliation): Check[] {
  const checks: Check[] = [];
  const senses = answer.senses;

  // The schema's cap, restated for the same reason tier 1 restates it above: a
  // provider that stopped honouring responseSchema is what this bucket notices.
  checks.push({ name: 'at most 5 senses', ok: senses.length <= 5, detail: `${senses.length}` });

  const rendered = senses.filter((sense) => sense.translation !== null);
  checks.push({
    name: 'at least one sense is rendered',
    ok: rendered.length >= 1,
    detail: `${rendered.length} of ${senses.length}`,
  });

  checks.push({
    name: 'distinct snake_case sense codes',
    ok:
      senses.every((sense) => /^[a-z0-9]+(_[a-z0-9]+)*$/.test(sense.sense_code)) &&
      new Set(senses.map((sense) => sense.sense_code)).size === senses.length,
    detail: senses.map((sense) => sense.sense_code).join(', '),
  });

  const to = kase.to ?? 'he';
  checks.push({
    name: `every rendered translation is in ${to} script`,
    ok: rendered.every((sense) => isInScript(sense.translation!, to)),
    detail: rendered.map((sense) => sense.translation).join(' | '),
  });

  return checks;
}

/** The scored axes of a rendering answer. */
function renderingTier2(kase: RenderingCase, answer: LlmReconciliation): Check[] {
  const checks: Check[] = [];
  const rendered = answer.senses.filter((sense) => sense.translation !== null);
  const known = new Set(kase.stored.map((sense) => sense.senseCode));

  if (kase.expectReused) {
    const missing = kase.expectReused.filter(
      (code) => !rendered.some((sense) => sense.sense_code === code),
    );
    checks.push({
      name: 'stored sense codes are reused rather than renamed',
      ok: missing.length === 0,
      detail: missing.length ? `missing: ${missing.join(', ')}` : undefined,
    });
  }

  // The phase 12 follow-up defect. Scored against EVERY rendered sense, not only the
  // invented ones: a reading that belongs to another lexeme of this form is
  // wrong here whatever code carries it.
  if (kase.rejectAny) {
    const offenders = rendered.filter((sense) =>
      kase.rejectAny!.some((rejected) => sense.translation!.includes(rejected)),
    );
    checks.push({
      name: "no reading belonging to another lexeme of this form",
      ok: offenders.length === 0,
      detail: offenders.length
        ? offenders
            .map(
              (sense) =>
                `${sense.sense_code}=${sense.translation}` +
                (known.has(sense.sense_code) ? ' (reused)' : ' (INVENTED)'),
            )
            .join(', ')
        : undefined,
    });
  }

  // The prompt asks for examples built around the queried form, not around the
  // headword — that rule is what makes a stored sense readable under a form the
  // learner actually typed.
  checks.push({
    name: 'every example is built around the queried form',
    ok: rendered.every(
      (sense) => !sense.example || sense.example.source.toLowerCase().includes(kase.form.toLowerCase()),
    ),
    detail: rendered
      .map((sense) => sense.example?.source ?? '(no example)')
      .join(' | '),
  });

  return checks;
}

const taskOf = (item: DistractorCase['items'][number]): Task => item.task ?? 'meaning';

/** Phase 19. The items as prepareSession builds them, keyed q1, q2, …. Phase
 *  23: with each item's task. */
function itemsOf(kase: DistractorCase) {
  return distractorItems(
    kase.items.map((item, index) => ({
      senseId: `s${index}`,
      variantId: `v${index}`,
      lexemeId: `l${index}`,
      form: item.form,
      lemma: item.lemma,
      partOfSpeech: item.partOfSpeech,
      translation: item.translation,
    })),
    kase.items.map(taskOf),
  );
}

const answeredItem = (kase: DistractorCase, answer: LlmDistractors, index: number) =>
  answer.items.find((answered) => answered.key === itemsOf(kase)[index].key);

function distractorTier1(kase: DistractorCase, answer: LlmDistractors): Check[] {
  const verdict = validateDistractors(itemsOf(kase), answer, kase.to, []);
  const checks: Check[] = [
    { name: 'every item answered as its task asks', ok: verdict.ok, detail: verdict.ok ? undefined : verdict.reason },
  ];
  // The options' language: Hebrew meanings on today's card, learned-language
  // words on the reversed card and in a typed card's alternatives.
  kase.items.forEach((item, index) => {
    const task = taskOf(item);
    const got = answeredItem(kase, answer, index);
    const texts = task === 'typed' ? (got?.alternatives ?? []) : (got?.distractors ?? []);
    const script = task === 'meaning' ? kase.to : kase.from;
    checks.push({
      name: `${item.form}: every ${task === 'typed' ? 'alternative' : 'wrong option'} is in ${script} script`,
      ok: texts.every((text) => isInScript(text, script)),
      detail: texts.join(' | '),
    });
  });
  return checks;
}

function distractorTier2(kase: DistractorCase, answer: LlmDistractors): Check[] {
  const same = (a: string, b: string) => normalizeForm(a).toLowerCase() === normalizeForm(b).toLowerCase();
  return kase.items.flatMap((item, index): Check[] => {
    const got = answeredItem(kase, answer, index);
    if (taskOf(item) === 'typed') {
      const known = item.alternatives ?? [];
      if (known.length === 0) return [];
      const listed = got?.alternatives ?? [];
      return [
        {
          name: `${item.form}: a known other right answer is accepted`,
          ok: listed.some((text) => known.some((alternative) => same(text, alternative))),
          detail: listed.join(' | ') || '(none)',
        },
      ];
    }
    const offered = got?.distractors ?? [];
    const offenders = offered.filter((text) => item.synonyms.some((synonym) => same(text, synonym)));
    return [
      {
        name: `${item.form}: no wrong option is a known right answer`,
        ok: offenders.length === 0,
        detail: offenders.length ? offenders.join(', ') : offered.join(' | '),
      },
    ];
  });
}

const sameText = (a: string, b: string) =>
  stripStress(a).replace(/\s+/g, ' ').trim().toLowerCase() === stripStress(b).replace(/\s+/g, ' ').trim().toLowerCase();

/** Phase 26. Each expected item is found when some read item has one of its
 *  spellings and, if Hebrew is expected, the same Hebrew after folding. Every
 *  read item no expectation claims is an extra. */
function photoChecks(kase: PhotoCase, items: ReadItem[]): Check[] {
  const claimed = new Set<number>();
  const checks: Check[] = kase.expect.map((expected) => {
    const index = items.findIndex(
      (item, i) =>
        !claimed.has(i) &&
        expected.text.some((text) => sameText(text, item.text)) &&
        (expected.hebrew === undefined || comparable(item.hebrew ?? '') === comparable(expected.hebrew)),
    );
    if (index !== -1) claimed.add(index);
    return {
      name: `found ${expected.text[0]}${expected.hebrew ? ` = ${expected.hebrew}` : ''}`,
      ok: index !== -1,
    };
  });
  items.forEach((item, i) => {
    if (!claimed.has(i)) checks.push({ name: `no extra item`, ok: false, detail: `${item.text}${item.hebrew ? ` = ${item.hebrew}` : ''}` });
  });
  return checks;
}

function matchCheck(kase: MatchCase, answer: number | 'none'): Check[] {
  return [{ name: `chose ${kase.expect === 'none' ? 'none' : `sense ${kase.expect + 1}`}`, ok: answer === kase.expect, detail: `${answer === 'none' ? 'none' : `sense ${answer + 1}`}` }];
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

  // An optional substring filter, matching `content:generate -- book`: iterating
  // on one prompt rule costs one call rather than fourteen. CI passes no
  // argument and therefore runs everything; the scorecard prints the counts it
  // actually scored, so a filtered run can never be mistaken for a full one.
  const filter = process.argv[2]?.trim().toLowerCase();
  const matches = (...fields: string[]) =>
    !filter || fields.some((field) => field.toLowerCase().includes(filter));

  const cases = CASES.filter((kase) => matches(kase.label, kase.text));
  const renderingCases = RENDERING_CASES.filter((kase) =>
    matches(kase.label, kase.form, kase.lemma),
  );
  const distractorCases = DISTRACTOR_CASES.filter((kase) =>
    matches(kase.label, ...kase.items.map((item) => item.form)),
  );
  const transcriptionCases = TRANSCRIPTION_CASES.filter((kase) =>
    matches(kase.label, kase.target, kase.file),
  );
  const photoCases = PHOTO_CASES.filter((kase) => matches(kase.label, kase.file));
  const matchCases = MATCH_CASES.filter((kase) => matches(kase.label, kase.word));
  const judgeCases = JUDGE_CASES.filter((kase) => matches(kase.label, kase.answer, kase.context.form));
  if (filter) console.log(`filter "${filter}"`);
  if (
    cases.length + renderingCases.length + distractorCases.length + transcriptionCases.length +
      photoCases.length + matchCases.length + judgeCases.length === 0
  ) {
    throw new Error(`filter "${filter}" matched no case`);
  }

  const llm = createGeminiClient({
    fetch: globalThis.fetch,
    baseUrl: gemini.baseUrl,
    apiKey: gemini.apiKey,
    model: gemini.model,
    timeoutMs: TIMEOUT_MS,
  });
  // Matches the options composition.ts gives the judge client, except the
  // timeout: the eval uses its own TIMEOUT_MS (30 s), not production's budget.
  const judgeLlm = createGeminiClient({
    fetch: globalThis.fetch,
    baseUrl: gemini.baseUrl,
    apiKey: gemini.apiKey,
    model: gemini.model,
    timeoutMs: TIMEOUT_MS,
    thinkingBudget: 0,
  });
  const transcriber = createGeminiTranscriber({
    fetch: globalThis.fetch,
    baseUrl: gemini.baseUrl,
    apiKey: gemini.apiKey,
    model: gemini.model,
    timeoutMs: TIMEOUT_MS,
  });
  const vision = createGeminiVisionClient({
    fetch: globalThis.fetch,
    baseUrl: gemini.baseUrl,
    apiKey: gemini.apiKey,
    model: gemini.model,
    timeoutMs: PHOTO_TIMEOUT_MS,
  });

  // One case, scored. Every failure is caught and becomes a tier 1 row rather
  // than rejecting: one case that cannot reach the model must not abandon the
  // other nine, and with several requests in flight an escaping rejection would
  // take the run down mid-flight.
  const scoreCase = async (kase: EvalCase): Promise<Row> => {
    try {
      const result = await askModel(llm, {
        text: kase.text,
        from: kase.from ?? 'en',
        to: kase.to ?? 'he',
      });
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

  /** The same catch-and-score-as-tier-1 contract as `scoreCase`, for the
   *  second call. */
  const scoreRendering = async (kase: RenderingCase): Promise<Row> => {
    try {
      const answer = await askRendering(llm, {
        form: kase.form,
        from: kase.from ?? 'en',
        to: kase.to ?? 'he',
        lemma: kase.lemma,
        partOfSpeech: kase.partOfSpeech,
        storedSenses: kase.stored,
      });
      return {
        label: kase.label,
        text: `${kase.form} \u2190 ${kase.lemma}/${kase.partOfSpeech}`,
        tier1: renderingTier1(kase, answer),
        tier2: renderingTier2(kase, answer),
        rendering: answer,
      };
    } catch (error) {
      return {
        label: kase.label,
        text: `${kase.form} \u2190 ${kase.lemma}/${kase.partOfSpeech}`,
        tier1: [{ name: 'the call succeeded', ok: false, detail: (error as Error).message }],
        tier2: [],
        error: (error as Error).message,
      };
    }
  };

  const scoreDistractors = async (kase: DistractorCase): Promise<Row> => {
    const text = kase.items.map((item) => item.form).join(', ');
    try {
      const answer = await askDistractors(llm, { from: kase.from, to: kase.to, items: itemsOf(kase) });
      return {
        label: kase.label,
        text,
        tier1: distractorTier1(kase, answer),
        tier2: distractorTier2(kase, answer),
        distractors: answer,
      };
    } catch (error) {
      return {
        label: kase.label,
        text,
        tier1: [{ name: 'the call succeeded', ok: false, detail: (error as Error).message }],
        tier2: [],
        error: (error as Error).message,
      };
    }
  };

  const scoreTranscription = async (kase: TranscriptionCase): Promise<Row> => {
    try {
      const heard = await askTranscription(transcriber, { file: kase.file, language: kase.language });
      const verdict = heard === null ? null : judgeSpoken({ forms: [kase.target], alternatives: [] }, heard) === 'understood' ? 'understood' : 'unheard';
      return {
        label: kase.label,
        text: kase.file,
        tier1: [{ name: 'the answer parses', ok: heard !== null, detail: heard === null ? 'unreadable' : undefined }],
        tier2: [{ name: `judged ${kase.expect}`, ok: verdict === kase.expect, detail: `heard "${heard ?? ''}"` }],
        heard: heard ?? undefined,
      };
    } catch (error) {
      return {
        label: kase.label,
        text: kase.file,
        tier1: [{ name: 'the call succeeded', ok: false, detail: (error as Error).message }],
        tier2: [],
        error: (error as Error).message,
      };
    }
  };

  const scorePhoto = async (kase: PhotoCase): Promise<Row> => {
    try {
      const items = await askPhoto(vision, { file: kase.file, language: kase.language });
      const checks = photoChecks(kase, items);
      return { label: kase.label, text: kase.file, tier1: kase.tier === 1 ? checks : [], tier2: kase.tier === 2 ? checks : [], photo: items };
    } catch (error) {
      return { label: kase.label, text: kase.file, tier1: [{ name: 'the call succeeded', ok: false, detail: (error as Error).message }], tier2: [], error: (error as Error).message };
    }
  };

  const scoreMatch = async (kase: MatchCase): Promise<Row> => {
    const text = `${kase.word} ← ${kase.hebrew}`;
    try {
      const answer = await askSenseMatch(llm, { word: kase.word, target: kase.target, hebrew: kase.hebrew, options: kase.options });
      const checks = matchCheck(kase, answer);
      return { label: kase.label, text, tier1: kase.tier === 1 ? checks : [], tier2: kase.tier === 2 ? checks : [], match: answer };
    } catch (error) {
      return { label: kase.label, text, tier1: [{ name: 'the call succeeded', ok: false, detail: (error as Error).message }], tier2: [], error: (error as Error).message };
    }
  };

  const scoreJudge = async (kase: JudgeCase): Promise<Row> => {
    try {
      const verdict = await askJudge(judgeLlm, kase);
      return {
        label: kase.label,
        text: kase.answer,
        tier1: [{ name: 'the answer parses', ok: verdict !== null, detail: verdict === null ? 'unreadable' : undefined }],
        tier2: [{ name: `judged ${kase.expect}`, ok: verdict === kase.expect, detail: `verdict ${verdict ?? 'none'}` }],
        verdict: verdict ?? undefined,
      };
    } catch (error) {
      return {
        label: kase.label,
        text: kase.answer,
        tier1: [{ name: 'the call succeeded', ok: false, detail: (error as Error).message }],
        tier2: [],
        error: (error as Error).message,
      };
    }
  };

  // Every call site of the provider, scored in one run and one scorecard. They
  // share the concurrency budget rather than each taking their own: the quota
  // they compete for is the same one.
  const started = Date.now();
  const [translationRows, renderingRows, distractorRows, transcriptionRows, photoRows, matchRows, judgeRows] =
    await Promise.all([
      mapWithConcurrency(cases, CONCURRENCY, scoreCase),
      mapWithConcurrency(renderingCases, CONCURRENCY, scoreRendering),
      mapWithConcurrency(distractorCases, CONCURRENCY, scoreDistractors),
      mapWithConcurrency(transcriptionCases, CONCURRENCY, scoreTranscription),
      mapWithConcurrency(photoCases, CONCURRENCY, scorePhoto),
      mapWithConcurrency(matchCases, CONCURRENCY, scoreMatch),
      mapWithConcurrency(judgeCases, CONCURRENCY, scoreJudge),
    ]);
  const rows = [
    ...translationRows,
    ...renderingRows,
    ...distractorRows,
    ...transcriptionRows,
    ...photoRows,
    ...matchRows,
    ...judgeRows,
  ];
  const elapsedMs = Date.now() - started;

  // Scorecard. Every case prints its actual output, so a drop is diagnosable
  // rather than merely red.
  let tier1Failures = 0;
  let tier2Passed = 0;
  let tier2Total = 0;
  // Transcription is scored on a line of its own: it is a different call and a
  // different kind of failure, and a good translation score must not hide it.
  let speechPassed = 0;
  let speechTotal = 0;
  // Phase 26's two calls, the photo read and the sense match, share a line of
  // their own for the same reason: pooled with translation, nearly every photo
  // check could fail with the gate still green.
  let photoPassed = 0;
  let photoTotal = 0;
  // Phase 27's judge too: a different call, judging a learner's answer.
  let judgePassed = 0;
  let judgeTotal = 0;

  for (const row of rows) {
    const t1Bad = row.tier1.filter((check) => !check.ok);
    const t2Bad = row.tier2.filter((check) => !check.ok);
    tier1Failures += t1Bad.length;
    const passed = row.tier2.filter((check) => check.ok).length;
    if (transcriptionRows.includes(row)) {
      speechPassed += passed;
      speechTotal += row.tier2.length;
    } else if (photoRows.includes(row) || matchRows.includes(row)) {
      photoPassed += passed;
      photoTotal += row.tier2.length;
    } else if (judgeRows.includes(row)) {
      judgePassed += passed;
      judgeTotal += row.tier2.length;
    } else {
      tier2Passed += passed;
      tier2Total += row.tier2.length;
    }

    const mark = t1Bad.length > 0 ? 'FAIL' : t2Bad.length > 0 ? 'warn' : 'ok  ';
    console.log(`\n[${mark}] ${row.text} — ${row.label}`);
    if (row.result) {
      console.log(
        `       kind=${row.result.kind} ${row.result.from}→${row.result.to} ` +
          `senses=${row.result.senses.map((sense) => sense.translation).join(' | ') || '(none)'}`,
      );
      // Phase 13. Without this, a failing correction check says only that it was
      // wrong — never what the model corrected to, which is the first thing
      // needed to tell a prompt regression from a model that picked a different
      // (also defensible) alternative.
      if (row.result.correction) {
        console.log(
          `       correction=${row.result.correction.corrected_form} ` +
            `alternatives=${row.result.correction.alternatives.join(', ') || '(none)'}`,
        );
      }
    }
    if (row.verdict !== undefined) console.log(`       verdict=${row.verdict}`);
    if (row.heard !== undefined) console.log(`       heard=${row.heard}`);
    if (row.photo) {
      console.log(`       items=${row.photo.map((item) => `${item.text}${item.hebrew ? `=${item.hebrew}` : ''}`).join(' | ') || '(none)'}`);
    }
    if (row.match !== undefined) console.log(`       chose=${row.match === 'none' ? 'none' : `sense ${row.match + 1}`}`);
    if (row.rendering) {
      console.log(
        `       senses=${
          row.rendering.senses
            .map((sense) => `${sense.sense_code}=${sense.translation ?? 'null'}`)
            .join(' | ') || '(none)'
        }`,
      );
    }
    if (row.distractors) {
      console.log(
        `       ${row.distractors.items
          .map((item) => `${item.key}=${item.distractors.join('/')}${item.alternatives?.length ? ` +${item.alternatives.join('/')}` : ''}`)
          .join(' | ')}`,
      );
    }
    for (const check of [...t1Bad, ...t2Bad]) {
      console.log(
        `       ${t1Bad.includes(check) ? 'T1' : 'T2'} ${check.name}: ${check.detail ?? ''}`,
      );
    }
  }

  const score = tier2Total === 0 ? 0 : tier2Passed / tier2Total;
  const transcriptionScore = speechTotal === 0 ? 0 : speechPassed / speechTotal;
  const photoScore = photoTotal === 0 ? 0 : photoPassed / photoTotal;
  const judgeScore = judgeTotal === 0 ? 0 : judgePassed / judgeTotal;
  console.log(
    `\ntier 1: ${tier1Failures} failure(s) (must be 0)\n` +
      `tier 2: ${tier2Passed}/${tier2Total} = ${(score * 100).toFixed(1)}% ` +
      `(threshold ${(TIER2_THRESHOLD * 100).toFixed(0)}%)\n` +
      `transcription tier 2: ${speechPassed}/${speechTotal} = ${(transcriptionScore * 100).toFixed(1)}% ` +
      `(threshold ${(TIER2_THRESHOLD * 100).toFixed(0)}%)\n` +
      `photo tier 2: ${photoPassed}/${photoTotal} = ${(photoScore * 100).toFixed(1)}% ` +
      `(threshold ${(TIER2_THRESHOLD * 100).toFixed(0)}%)\n` +
      `judge tier 2: ${judgePassed}/${judgeTotal} = ${(judgeScore * 100).toFixed(1)}% ` +
      `(threshold ${(TIER2_THRESHOLD * 100).toFixed(0)}%)\n` +
      `${cases.length} translation + ${renderingCases.length} rendering + ${distractorCases.length} distractor + ${transcriptionCases.length} transcription + ${photoCases.length} photo + ${matchCases.length} match + ${judgeCases.length} judge cases in ` +
      `${(elapsedMs / 1000).toFixed(1)}s ` +
      `at concurrency ${CONCURRENCY}`,
  );

  // Gitignored, so a prompt change can be diffed against the previous run
  // instead of judged from memory.
  const dir = join(__dirname, '.results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ model: gemini.model, score, transcriptionScore, photoScore, judgeScore, rows }, null, 2));
  console.log(`report: ${file}`);

  // A group with no checks (a filtered run) has nothing to fail on.
  const belowThreshold = (total: number, value: number) => total > 0 && value < TIER2_THRESHOLD;
  if (
    tier1Failures > 0 ||
    belowThreshold(tier2Total, score) ||
    belowThreshold(speechTotal, transcriptionScore) ||
    belowThreshold(photoTotal, photoScore) ||
    belowThreshold(judgeTotal, judgeScore)
  ) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
