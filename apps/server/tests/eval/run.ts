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
import { readCheck, type CheckItem } from '../../src/domain/check';
import { findGap } from '../../src/domain/cloze';
import { ASKED_DISTRACTORS, comparable, distractorItems, KEPT_DISTRACTORS, nothingKnown, validateDistractors, type DistractorItem, type Generated, type LearnerWord, type RecentSentences, type Task } from '../../src/domain/distractors';
import { candidateItems, gapCheckItem, gapFaults, pointFaults, rewriteItems, rewriteOthers, type GapJudged } from '../../src/domain/gapRewrite';
import { POINT_REWRITE_ROUNDS, judgePoint, pointItem, readPoint, type PointFinding, type PointItem } from '../../src/domain/pointing';
import { isInScript, stripStress, type LanguageCode } from '../../src/domain/languages';
import type { SentenceContent } from '../../src/domain/sentences';
import { TRANSLATION_JUDGE_THINKING } from '../../src/domain/judge';
import { EXPLAIN_THINKING } from '../../src/domain/explain';
import { DEFAULT_SOUND_ALIKE_THRESHOLD } from '../../src/domain/soundAlike';
import { POINT_CHECK_THINKING, SESSION_GENERATION_THINKING } from '../../src/domain/jobs';
import type { ReadItem } from '../../src/domain/photoReading';
import { createGeminiClient, createGeminiTranscriber, createGeminiVisionClient } from '../../src/providers/gemini';
import { judgeSpoken, judgeTyped, normaliseGloss } from '@lang-tutor/core/domain';
import type { LlmAccept, LlmDistractors, LlmReconciliation } from '@lang-tutor/core/api';

import { askAccept, askCheck, askContext, askDistractors, askExplain, askFitJudge, askGapGuesses, askJudge, askModel, askPoint, askRendering, askSoundAlike, askTranscription, askTranslationJudge, type ModelAnswer } from './askModel';
import {
  ACCEPT_CASES,
  CASES,
  CHECK_CASES,
  CONTEXT_CASES,
  DISTRACTOR_CASES,
  FIT_JUDGE_CASES,
  GAP_CASES,
  JUDGE_CASES,
  POINT_CASES,
  SOUND_ALIKE_CASES,
  RENDERING_CASES,
  SENTENCE_CASES,
  TRANSCRIPTION_CASES,
  TRANSLATE_CASES,
  TRANSLATION_JUDGE_CASES,
  EXPLAIN_CASES,
  type AcceptCase,
  type ExplainCase,
  type CheckCase,
  type ContextCase,
  type DistractorCase,
  type EvalCase,
  type FitJudgeCase,
  type JudgeCase,
  type PointCase,
  type RenderingCase,
  type SentenceCase,
  type SoundAlikeCase,
  type TranscriptionCase,
  type TranslationJudgeCase,
} from './cases';
import { askPhoto, askSenseMatch } from './askPhoto';
import { checkTier1, checkTier2, checkWritten } from './checkChecks';
import { contextItemOf, contextTier1, contextTier2, contextWritten } from './contextChecks';
import { retryOverloaded } from './overload';
import { MATCH_CASES, PHOTO_CASES, type MatchCase, type PhotoCase } from './photoCases';

const TIER2_THRESHOLD = 0.85;
/** Phase 47 (ruling R6). The eval has no database: its calls are not recorded. */
const RECORDS_NOTHING = async (): Promise<void> => {};
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

// One 503 retried before it counts (overload.ts): every client of the run uses it.
const evalFetch = retryOverloaded(globalThis.fetch);

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
  /** Phase 34. Set on an accept row: the answer as written, and what the server keeps. */
  accept?: { raw: LlmAccept; answers: string[]; answerForm: string | null };
  /** Set on a transcription row: what the model heard. */
  heard?: string;
  /** Set on a photo row: what the reading found. */
  photo?: ReadItem[];
  /** Set on a match row: the sense the model chose. */
  match?: number | 'none';
  /** Set on a judge row: the verdict received. */
  verdict?: string;
  /** Set on a gap, sentence or translate row: what the model wrote, one line per item. */
  written?: string[];
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
      ok: senses.every((sense) => !sense.part_of_speech && !sense.examples),
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
      ok: senses.every(
        (sense) => (sense.examples ?? []).length > 0 && sense.examples!.every((example) => example.source.trim()),
      ),
    });
    checks.push({
      name: 'every example carries a non-empty translation',
      ok: senses.every(
        (sense) => (sense.examples ?? []).length > 0 && sense.examples!.every((example) => example.target.trim()),
      ),
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
      .flatMap((sense) => (sense.examples ?? []).map((example) => example.source))
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

  // Phase 31 (spec D4-D6, D9).
  const allSenses = result.entries.flatMap((entry) => entry.senses);
  if (kase.expectOneTranslation) {
    const lists = allSenses.filter((sense) => /[,/;()]/u.test(sense.translation));
    checks.push({
      name: 'every translation is one translation, with no list and no note',
      ok: lists.length === 0,
      detail: lists.map((sense) => sense.translation).join(' | ') || undefined,
    });
  }
  if (kase.expectGloss) {
    const gloss = result.entries[0]?.senses[0]?.gloss;
    checks.push({
      name: `the citation form is one of ${kase.expectGloss.join(', ')}`,
      ok: gloss !== undefined && kase.expectGloss.some((accepted) => normaliseGloss(accepted) === normaliseGloss(gloss)),
      detail: gloss ?? 'none',
    });
  }
  if (kase.expectAlternativesIn) {
    // The first call asks for no citation alternatives (see LlmSenseSchema).
    const words = allSenses.flatMap((sense) => sense.alternatives ?? []);
    checks.push({
      name: `every alternative is in ${kase.expectAlternativesIn} script`,
      ok: words.every((word) => isInScript(word, kase.expectAlternativesIn!)),
      detail: words.join(' | ') || 'none',
    });
  }
  if (kase.expectAlternativeWord) {
    const listed = allSenses.flatMap((sense) => sense.alternatives ?? []);
    checks.push({
      name: `lists one of ${kase.expectAlternativeWord.join(', ')} as an alternative`,
      ok: kase.expectAlternativeWord.some((word) => listed.some((alt) => normaliseGloss(alt) === normaliseGloss(word))),
      detail: listed.join(' | ') || 'none',
    });
  }
  if (kase.expectDefinitionIn) {
    checks.push({
      name: `every sense has a definition in ${kase.expectDefinitionIn} script`,
      ok: allSenses.length > 0 && allSenses.every((sense) => Boolean(sense.definition?.trim()) && isInScript(sense.definition!, kase.expectDefinitionIn!)),
      detail: allSenses.map((sense) => sense.definition ?? 'none').join(' | '),
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

/** Phase 34 (spec D1). Invariants of an accept answer, whatever it lists: it
 *  parses (or the row records the failed call), and every answer as written is
 *  in the target language's script, so never in the explanation's. */
function acceptTier1(kase: AcceptCase, answer: { raw: LlmAccept }): Check[] {
  const outside = answer.raw.answers.filter((text) => !isInScript(text, kase.target));
  return [
    {
      name: `every answer is in ${kase.target} script`,
      ok: outside.length === 0,
      detail: outside.length ? outside.join(' | ') : undefined,
    },
  ];
}

/** Phase 34 (spec D1, D2). The scored axes: the right answers a card refused
 *  before the list existed are kept, placeholders are written out, and the
 *  answer form agrees with the rendering. */
function acceptTier2(kase: AcceptCase, answer: { raw: LlmAccept; answers: string[]; answerForm: string | null }): Check[] {
  const checks: Check[] = [];
  // Scored as the card will judge it: the typed judge over the kept list, so a
  // kept `to lose my temper` accepts a typed `lose my temper`, as it would.
  const target = { answer: kase.form, lemma: kase.lemma, alternatives: answer.answers };
  for (const word of kase.expectAnswers ?? []) {
    checks.push({
      name: `accepts ${word}`,
      ok: ['exact', 'alternative'].includes(judgeTyped(target, word)),
      detail: answer.answers.join(' | ') || 'none',
    });
  }
  if (kase.rejectSubstrings) {
    const offenders = answer.raw.answers.filter((text) =>
      kase.rejectSubstrings!.some((placeholder) => text.toLowerCase().includes(placeholder)),
    );
    checks.push({
      name: 'writes every placeholder out',
      ok: offenders.length === 0,
      detail: offenders.length ? offenders.join(' | ') : undefined,
    });
  }
  if (kase.expectAnswerForm !== undefined) {
    const expected = kase.expectAnswerForm;
    checks.push({
      name: expected === null ? 'keeps the form, no answer form' : `answer form ${expected}`,
      ok: expected === null ? answer.answerForm === null : answer.answerForm !== null && comparable(answer.answerForm) === comparable(expected),
      detail: `answer_form=${answer.raw.answer_form ?? 'null'}`,
    });
  }
  return checks;
}

const taskOf = (item: DistractorCase['items'][number]): Task => item.task ?? 'meaning';

/** Phase 19. The items as prepareSession builds them, keyed q1, q2, …. Phase
 *  23: with each item's task. */
function itemsOf(kase: DistractorCase) {
  return distractorItems(
    kase.items.map((item, index) => ({
      glossId: `g-s${index}`,
      senseId: `s${index}`,
      variantId: `v${index}`,
      lexemeId: `l${index}`,
      form: item.form,
      lemma: item.lemma,
      partOfSpeech: item.partOfSpeech,
      translation: item.translation,
      example: null,
      exampleTranslation: null,
      acceptedAnswers: [],
      answerForm: null,
      acceptedAt: null,
    })),
    kase.items.map(taskOf),
    new Map(),
  );
}

const answeredItem = (kase: DistractorCase, answer: LlmDistractors, index: number) =>
  answer.items.find((answered) => answered.key === itemsOf(kase)[index].key);

function distractorTier1(kase: DistractorCase, answer: LlmDistractors): Check[] {
  const verdict = validateDistractors(itemsOf(kase), answer, kase.to, [], kase.from as LanguageCode, nothingKnown());
  const checks: Check[] = [
    { name: 'every item answered as its task asks', ok: verdict.refused.size === 0, detail: verdict.refused.size ? [...verdict.refused.values()].join('; ') : undefined },
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

/** Phase 27 Part B. The items as prepareSession builds them for a gap, sentence or
 *  translate case: each with its saved example, and the sentences to avoid as the
 *  service reads them from the last sessions. */
function sentenceItemsOf(kase: SentenceCase) {
  // Phase 31: keyed by gloss id, as findRecentSentences keys them.
  const recent: RecentSentences = new Map(
    kase.items.map((item, index) => [`g-s${index}`, { cloze: item.avoidTarget ?? [], translate: item.avoidHebrew ?? [] }]),
  );
  return distractorItems(
    kase.items.map((item, index) => ({
      glossId: `g-s${index}`,
      senseId: `s${index}`,
      variantId: `v${index}`,
      lexemeId: `l${index}`,
      form: item.form,
      lemma: item.lemma,
      partOfSpeech: item.partOfSpeech,
      translation: item.translation,
      example: item.example,
      exampleTranslation: item.exampleTranslation,
      acceptedAnswers: [],
      answerForm: null,
      acceptedAt: null,
    })),
    kase.items.map(() => kase.task),
    recent,
  );
}

/** Whole words, in any script: letters with their points, split on everything else. */
const wordsOf = (text: string): Set<string> =>
  new Set(text.toLowerCase().split(/[^\p{L}\p{M}]+/u).filter((token) => token !== ''));

function sentenceTier1(kase: SentenceCase, answer: LlmDistractors): Check[] {
  const items = sentenceItemsOf(kase);
  const verdict = validateDistractors(items, answer, 'he', [], kase.from as LanguageCode, nothingKnown());
  if (verdict.refused.size > 0) return [{ name: 'every item answered as its task asks', ok: false, detail: [...verdict.refused.values()].join('; ') }];
  if (kase.task === 'gap') {
    return [
      { name: 'every item answered as its task asks', ok: true },
      ...kase.items.map((item, index): Check => {
        const options = answer.items.find((answered) => answered.key === items[index].key)?.distractors ?? [];
        return {
          name: `${item.form}: every wrong option is in ${kase.from} script`,
          ok: options.every((text) => isInScript(text, kase.from)),
          detail: options.join(' | '),
        };
      }),
    ];
  }
  // A degraded item is what a learner would see as a typed translation instead.
  return kase.items.map((item, index): Check => {
    const generated = verdict.byKey.get(items[index].key);
    const degraded = generated ? generated.degraded : 'no answer';
    return { name: `${item.form}: the ${kase.task} card is usable`, ok: degraded === null, detail: degraded ?? undefined };
  });
}

function sentenceTier2(kase: SentenceCase, answer: LlmDistractors): Check[] {
  const items = sentenceItemsOf(kase);
  return kase.items.flatMap((item, index): Check[] => {
    const got = answer.items.find((answered) => answered.key === items[index].key);
    // Phase 62 (spec D1): a gap item's sentence is its own, so its wrong options are
    // the checker's to read against it (survivesChecker), not a list made beforehand.
    if (kase.task === 'gap') return [];
    // Phase 38 (spec D2). The typed gap hides its Hebrew, so its alternatives are the
    // words that fit the sentence read alone; an everyday sentence admits one.
    const fits: Check[] =
      kase.task === 'sentence'
        ? [
            {
              name: `${item.form}: lists another word that fits the gap read alone`,
              ok: (got?.alternatives ?? []).length > 0,
              detail: `${got?.sentence ?? '(none)'} +${(got?.alternatives ?? []).join('/')}`,
            },
          ]
        : [];
    if (!item.offSense?.length) return fits;
    const seen = new Set([...wordsOf(got?.sentence ?? ''), ...wordsOf(got?.translation ?? '')]);
    const offenders = item.offSense.filter((text) => seen.has(text.toLowerCase()));
    return [
      ...fits,
      {
        name: `${item.form}: no word of another sense`,
        ok: offenders.length === 0,
        detail: offenders.length ? offenders.join(', ') : `${got?.sentence} / ${got?.translation}`,
      },
    ];
  });
}

/** Phase 59 (spec D1). The share of a translation's words, its practised word left
 *  out, that come from the learner's list (phase 62: of the target-language side,
 *  a gap or sentence item's `sentence`, a translate item's `translation`): a word counts when it is a list word or
 *  shares its first four letters with one (fratelli, ora), or is a list word of up to
 *  three letters exactly (io, ho, qui, con). Words of one or two letters that are
 *  not on the list (e, a, il, la) are grammar and left out of the count. */
const LIST_SHARE_THRESHOLD = 0.5;

function listShare(kase: SentenceCase, answer: LlmDistractors): Check[] {
  if (!kase.learner) return [];
  const listWords = [...new Set(kase.learner.flatMap((entry) => entry.word.toLowerCase().split(/\s+/u)))];
  const fromList = (token: string) =>
    listWords.some((word) => token === word || (word.length >= 4 && token.length >= 4 && token.slice(0, 4) === word.slice(0, 4)));
  const items = sentenceItemsOf(kase);
  return kase.items.map((item, index): Check => {
    const got = answer.items.find((answered) => answered.key === items[index].key);
    const gap = new Set((got?.gap ?? '').toLowerCase().split(/[^\p{L}\p{M}]+/u).filter(Boolean));
    const target = kase.task === 'translate' ? got?.translation : got?.sentence;
    const tokens = (target ?? '')
      .toLowerCase()
      .split(/[^\p{L}\p{M}]+/u)
      .filter((token) => token !== '' && !gap.has(token))
      .filter((token) => token.length > 2 || fromList(token));
    const share = tokens.length === 0 ? 1 : tokens.filter(fromList).length / tokens.length;
    return {
      name: kase.task === 'translate' ? `${item.form}: the translation is built from the learner's list` : `${item.form}: the sentence is built from the learner's list`,
      ok: share >= LIST_SHARE_THRESHOLD,
      detail: `${(share * 100).toFixed(0)}%: ${target ?? '(none)'}`,
    };
  });
}

const writtenBy = (kase: SentenceCase, answer: LlmDistractors): string[] => {
  const items = sentenceItemsOf(kase);
  return kase.items.map((item, index) => {
    const got = answer.items.find((answered) => answered.key === items[index].key);
    return kase.task === 'gap'
      ? `${item.form}: ${got?.sentence ?? '(none)'} [${got?.gap ?? ''}] = ${got?.translation ?? '(none)'} | wrong ${(got?.distractors ?? []).join(' / ')}`
      : `${item.form}: ${got?.sentence ?? '(none)'} [${got?.gap ?? ''}] = ${got?.translation ?? '(none)'}${got?.alternatives?.length ? ` +${got.alternatives.join('/')}` : ''}`;
  });
};

const sameText = (a: string, b: string) =>
  stripStress(a).replace(/\s+/g, ' ').trim().toLowerCase() === stripStress(b).replace(/\s+/g, ' ').trim().toLowerCase();

/** Phase 26. Each expected item is found when some read item has one of its
 *  spellings and, if Hebrew is expected, one of its Hebrew readings after
 *  folding. Every read item no expectation claims is an extra. */
function photoChecks(kase: PhotoCase, items: ReadItem[]): Check[] {
  const claimed = new Set<number>();
  const checks: Check[] = kase.expect.map((expected) => {
    const index = items.findIndex(
      (item, i) =>
        !claimed.has(i) &&
        expected.text.some((text) => sameText(text, item.text)) &&
        (expected.hebrew === undefined ||
          expected.hebrew.some((hebrew) => comparable(item.hebrew ?? '') === comparable(hebrew))),
    );
    if (index !== -1) claimed.add(index);
    return {
      name: `found ${expected.text[0]}${expected.hebrew ? ` = ${expected.hebrew[0]}` : ''}`,
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
  const acceptCases = ACCEPT_CASES.filter((kase) => matches(kase.label, kase.form, kase.rendering));
  const distractorCases = DISTRACTOR_CASES.filter((kase) =>
    matches(kase.label, ...kase.items.map((item) => item.form)),
  );
  const transcriptionCases = TRANSCRIPTION_CASES.filter((kase) =>
    matches(kase.label, kase.target, kase.file),
  );
  const photoCases = PHOTO_CASES.filter((kase) => matches(kase.label, kase.file));
  const matchCases = MATCH_CASES.filter((kase) => matches(kase.label, kase.word));
  const judgeCases = JUDGE_CASES.filter((kase) => matches(kase.label, kase.answer, kase.context.form));
  // The Part B groups match on their label alone: a filter such as "sentence" or
  // "gap" must select a group, not every case whose word happens to contain it.
  const gapCases = GAP_CASES.filter((kase) => matches(kase.label));
  const sentenceCases = SENTENCE_CASES.filter((kase) => matches(kase.label));
  const translateCases = TRANSLATE_CASES.filter((kase) => matches(kase.label));
  const tjudgeCases = TRANSLATION_JUDGE_CASES.filter((kase) => matches(kase.label));
  // Phase 66. Every label starts "explain ", so that filter selects the group.
  const explainCases = EXPLAIN_CASES.filter((kase) => matches(kase.label));
  const fitCases = FIT_JUDGE_CASES.filter((kase) => matches(kase.label));
  const contextCases = CONTEXT_CASES.filter((kase) => matches(kase.label));
  const checkCases = CHECK_CASES.filter((kase) => matches(kase.label));
  // Phase 50. Every label starts "sound", so the filter "sound" selects the group.
  const soundCases = SOUND_ALIKE_CASES.filter((kase) => matches(kase.label));
  // Phase 62d. Every label starts "point ", so the filter "point " selects the group.
  const pointCases = POINT_CASES.filter((kase) => matches(kase.label));
  if (filter) console.log(`filter "${filter}"`);
  if (
    cases.length + renderingCases.length + acceptCases.length + distractorCases.length + transcriptionCases.length +
      photoCases.length + matchCases.length + judgeCases.length +
      gapCases.length + sentenceCases.length + translateCases.length + tjudgeCases.length + fitCases.length + contextCases.length +
      checkCases.length + soundCases.length + pointCases.length + explainCases.length === 0
  ) {
    throw new Error(`filter "${filter}" matched no case`);
  }

  const llm = createGeminiClient({
    fetch: evalFetch,
    baseUrl: gemini.baseUrl,
    apiKey: gemini.apiKey,
    model: gemini.model,
    onCall: RECORDS_NOTHING,
    now: Date.now,
    timeoutMs: TIMEOUT_MS,
  });
  // Phase 47 (spec D1). The session-generation prompt on the client composition.ts
  // gives it: thinking capped. The rest of the prompts keep the plain client.
  const sessionLlm = createGeminiClient({
    fetch: evalFetch,
    baseUrl: gemini.baseUrl,
    apiKey: gemini.apiKey,
    model: gemini.model,
    onCall: RECORDS_NOTHING,
    now: Date.now,
    timeoutMs: TIMEOUT_MS,
    thinkingBudget: SESSION_GENERATION_THINKING,
  });
  // Phase 62d (spec D2). The point check on the client composition.ts gives it: thinking capped.
  const pointLlm = createGeminiClient({
    fetch: evalFetch,
    baseUrl: gemini.baseUrl,
    apiKey: gemini.apiKey,
    model: gemini.model,
    onCall: RECORDS_NOTHING,
    now: Date.now,
    timeoutMs: TIMEOUT_MS,
    thinkingBudget: POINT_CHECK_THINKING,
  });
  // Matches the options composition.ts gives the judge client, except the
  // timeout: the eval uses its own TIMEOUT_MS (30 s), not production's budget.
  const judgeLlm = createGeminiClient({
    fetch: evalFetch,
    baseUrl: gemini.baseUrl,
    apiKey: gemini.apiKey,
    model: gemini.model,
    onCall: RECORDS_NOTHING,
    now: Date.now,
    timeoutMs: TIMEOUT_MS,
    thinkingBudget: 0,
  });
  // Phase 45 (spec D3). The translation judge's own client, as composition.ts builds it.
  const translationJudgeLlm = createGeminiClient({
    fetch: evalFetch,
    baseUrl: gemini.baseUrl,
    apiKey: gemini.apiKey,
    model: gemini.model,
    onCall: RECORDS_NOTHING,
    now: Date.now,
    timeoutMs: TIMEOUT_MS,
    thinkingBudget: TRANSLATION_JUDGE_THINKING,
  });
  // Phase 66 (spec D2). The explainer's own client, as composition.ts builds it.
  const explainLlm = createGeminiClient({
    fetch: globalThis.fetch,
    baseUrl: gemini.baseUrl,
    apiKey: gemini.apiKey,
    model: gemini.model,
    onCall: RECORDS_NOTHING,
    now: Date.now,
    timeoutMs: TIMEOUT_MS,
    thinkingBudget: EXPLAIN_THINKING,
  });
  const transcriber = createGeminiTranscriber({
    fetch: evalFetch,
    baseUrl: gemini.baseUrl,
    apiKey: gemini.apiKey,
    model: gemini.model,
    onCall: RECORDS_NOTHING,
    now: Date.now,
    timeoutMs: TIMEOUT_MS,
  });
  const vision = createGeminiVisionClient({
    fetch: evalFetch,
    baseUrl: gemini.baseUrl,
    apiKey: gemini.apiKey,
    model: gemini.model,
    onCall: RECORDS_NOTHING,
    now: Date.now,
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

  /** Phase 34. The same contract, for the accept call. */
  const scoreAccept = async (kase: AcceptCase): Promise<Row> => {
    const text = `${kase.rendering} \u2192 ${kase.form}`;
    try {
      const answer = await askAccept(llm, {
        form: kase.form,
        lemma: kase.lemma,
        partOfSpeech: kase.partOfSpeech,
        rendering: kase.rendering,
        example: kase.example,
        exampleTranslation: kase.exampleTranslation,
        target: kase.target,
        explanation: kase.explanation ?? 'he',
      });
      return { label: kase.label, text, tier1: acceptTier1(kase, answer), tier2: acceptTier2(kase, answer), accept: answer };
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

  const scoreDistractors = async (kase: DistractorCase): Promise<Row> => {
    const text = kase.items.map((item) => item.form).join(', ');
    try {
      const answer = await askDistractors(sessionLlm, { from: kase.from, to: kase.to, items: itemsOf(kase) });
      return {
        label: kase.label,
        text,
        tier1: distractorTier1(kase, answer),
        tier2: [...distractorTier2(kase, answer), ...(kase.checked ? await survivesChecker(kase.from, kase.to, itemsOf(kase), answer) : [])],
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

  const scoreSentences = async (kase: SentenceCase): Promise<Row> => {
    const text = kase.items.map((item) => item.form).join(', ');
    try {
      const learnerWords = kase.learner?.map((entry, index) => ({ key: `w${index + 1}`, glossId: `g-w${index + 1}`, ...entry }));
      const answer = await askDistractors(sessionLlm, { from: kase.from, to: 'he', items: sentenceItemsOf(kase), learnerWords });
      // Phase 62c (spec D6). A gap to choose's cards as production shows them, after its one
      // rewrite: tier 1 still reads the first answer, and every tier-2 check the cards shown.
      const rescue = kase.checked ? await rescueGaps(kase.from as LanguageCode, 'he', sentenceItemsOf(kase), answer, learnerWords) : null;
      // Phase 62d (spec D6). A typed gap's cards as production shows them, after the point
      // check and its one rewrite: every tier-2 check reads the last sentence written.
      const pointed = kase.task === 'sentence' ? await rescuePoints(kase, answer, learnerWords) : null;
      const shown = rescue?.shown ?? pointed?.shown ?? answer;
      return {
        label: kase.label,
        text,
        tier1: [...sentenceTier1(kase, answer), ...(rescue?.tier1 ?? []), ...(pointed?.tier1 ?? [])],
        tier2: [
          ...sentenceTier2(kase, shown),
          // Phase 62d (ruling R4): a typed gap's list share is the batch's first answer's, as on
          // master; a rescued sentence may leave the list where pointing needs it (R2), and its
          // share is printed below, not gated. Victor's ruling (2026-10-20): a gap to choose is
          // first a card only its word fits, then one of the learner's words, and one with none
          // of them is still a good card, so its list share is printed below, not gated.
          ...(kase.task === 'gap' ? [] : listShare(kase, pointed ? answer : shown)),
          // Phase 62 (spec D1, ruling R5): today's checks, unchanged: the probe on a typed
          // gap's sentence, the checker on a gap to choose's (every gap case is `checked`).
          ...(kase.task === 'sentence' ? await pointsToWord(kase, shown) : []),
          ...(rescue?.tier2 ?? []),
          ...(pointed?.tier2 ?? []),
        ],
        written: [
          ...writtenBy(kase, shown),
          ...(rescue?.written ?? []),
          ...(pointed?.written ?? []),
          ...(pointed && pointed.shown !== answer ? listShare(kase, pointed.shown).map((check) => `shown list share, not gated: ${check.name}: ${check.detail}`) : []),
          ...(kase.task === 'gap' ? listShare(kase, shown).map((check) => `list share, not gated: ${check.name}: ${check.detail}`) : []),
        ],
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

  // Phase 41 (spec D1). Read alone, the gapped sentence's likeliest fills include its
  // word: the gap as written, or the item's own form or lemma.
  const pointsToWord = async (kase: SentenceCase, answer: LlmDistractors): Promise<Check[]> => {
    // One item at a time, inside the row's own concurrency slot; a probe that fails
    // is a failed tier 2 check of its own, never the row's tier 1 (review M4).
    const items = sentenceItemsOf(kase);
    const checks: Check[] = [];
    for (const [index, item] of kase.items.entries()) {
      const name = `${item.form}: the sentence points to its word`;
      const got = answer.items.find((answered) => answered.key === items[index].key);
      // Found as production finds it (findGap): whole words, any case, so a gap that
      // opens its sentence (Compro for compro) is found too.
      const at = got?.sentence && got.gap ? findGap(got.sentence, [got.gap]) : null;
      if (!got?.sentence || !got.gap || !at) {
        checks.push({ name, ok: false, detail: 'no sentence' });
        continue;
      }
      const gapped = `${got.sentence.slice(0, at.start)}___${got.sentence.slice(at.end)}`;
      try {
        const guesses = await askGapGuesses(judgeLlm, { language: kase.from as LanguageCode, sentence: gapped });
        const target = { answer: got.gap, lemma: item.lemma, alternatives: [item.form] };
        checks.push({ name, ok: guesses.some((guess) => judgeTyped(target, guess) !== 'wrong'), detail: `${gapped} → ${guesses.join(' / ')}` });
      } catch (error) {
        checks.push({ name, ok: false, detail: `the probe failed: ${(error as Error).message}` });
      }
    }
    return checks;
  };

  // Phase 48 (spec D8). The checker as prepareSession asks it: each choice or gap item's usable
  // options, at most six; at least three must survive, or production would refuse the card.
  const survivesChecker = async (from: LanguageCode, to: LanguageCode, items: DistractorItem[], answer: LlmDistractors): Promise<Check[]> => {
    const verdict = validateDistractors(items, answer, to, [], from, nothingKnown());
    const checkItems: CheckItem[] = items.flatMap((item): CheckItem[] => {
      const made = verdict.byKey.get(item.key);
      const options = made ? [...made.distractors, ...made.spares].slice(0, ASKED_DISTRACTORS) : [];
      if (options.length === 0) return [];
      if (item.task === 'meaning') return [{ key: item.key, task: 'choice', word: item.form, options }];
      if (item.task === 'word') return [{ key: item.key, task: 'choice', word: item.translation, options }];
      return [];
    });
    if (checkItems.length === 0) return [{ name: 'the checker had options to judge', ok: false }];
    try {
      const reading = readCheck(checkItems, await askCheck(llm, { from, to, items: checkItems }));
      return checkItems.map((item): Check => {
        const finding = reading.byKey.get(item.key);
        const right = finding && (finding.task === 'choice' || finding.task === 'gap') ? finding.alsoRight : [];
        const options = item.task === 'choice' || item.task === 'gap' ? item.options : [];
        const left = options.filter((_, at) => !right[at]);
        return {
          name: `${item.key}: ${KEPT_DISTRACTORS} or more wrong options survive the checker`,
          ok: !reading.unjudged.has(item.key) && left.length >= KEPT_DISTRACTORS,
          detail: `kept ${left.join(' | ')}; right ${options.filter((_, at) => right[at]).join(' | ') || '(none)'}`,
        };
      });
    } catch (error) {
      return [{ name: 'the checker answered', ok: false, detail: (error as Error).message }];
    }
  };

  // Phase 62d (spec D6). prepareSession's rescue of a typed gap, through the same domain
  // functions: the point check of what validation kept, one rewrite of every sentence the
  // reader could not place, validated as production validates it, and the re-check of the
  // rewritten ones. A card production would write as a typed translation fails one check,
  // and so does one the check could not judge: it is the sentence shown that must point.
  const rescuePoints = async (
    kase: SentenceCase,
    answer: LlmDistractors,
    learnerWords: LearnerWord[] | undefined,
  ): Promise<{ shown: LlmDistractors; tier1: Check[]; tier2: Check[]; written: string[] }> => {
    const from = kase.from as LanguageCode;
    const to: LanguageCode = 'he';
    const items = sentenceItemsOf(kase);
    const verdict = validateDistractors(items, answer, to, [], from, nothingKnown());
    const made = new Map(verdict.byKey);
    const targetOf = (key: string) => {
      const { form, lemma, translation } = kase.items[items.findIndex((item) => item.key === key)];
      const { sentence, gap } = made.get(key)!.sentence!;
      return { word: { answer: sentence.slice(gap.start, gap.end), lemma, alternatives: [form] }, meanings: [translation] };
    };
    const tier1: Check[] = [];
    const written: string[] = [];
    // Each typed gap's outcome: null when the sentence shown points, else why not.
    const status = new Map<string, string | null>();
    // One call per sentence, side by side, as prepareSession asks them.
    const read = async (asked: PointItem[], label: string): Promise<ReadonlyMap<string, PointFinding>> => {
      const started = Date.now();
      const found = await Promise.all(
        asked.map(async (item) => {
          try {
            return [...readPoint([item], await askPoint(pointLlm, { from, to, items: [item] }))];
          } catch (error) {
            written.push(`${label} of ${item.key} failed: ${(error as Error).message}`);
            return [];
          }
        }),
      );
      if (asked.length > 0) written.push(`${label}: ${Date.now() - started} ms`);
      return new Map(found.flat());
    };
    const judge = (asked: PointItem[], reading: ReadonlyMap<string, PointFinding>, label: string) => {
      const failed = new Map<string, { fits: string[]; problem: string }>();
      for (const item of asked) {
        const finding = reading.get(item.key);
        if (!finding) {
          status.set(item.key, `the ${label} did not judge it`);
          continue;
        }
        const found = judgePoint(finding, targetOf(item.key));
        written.push(`${label} ${item.key}: ${item.sentence} → ${finding.guesses.join(' / ')} (${finding.meaning}, ${finding.readers}/10)`);
        status.set(item.key, found.points ? null : found.problem);
        if (!found.points) failed.set(item.key, { fits: found.fits, problem: found.problem });
      }
      return failed;
    };
    const asked = items.flatMap((item) => {
      const card = made.get(item.key);
      return card?.sentence ? [pointItem(item.key, card.sentence)] : [];
    });
    const failed = judge(asked, await read(asked, 'point check'), 'point check');
    let shown = answer;
    // Up to POINT_REWRITE_ROUNDS rounds per typed gap, as prepareSession runs them: one call
    // writes its candidates (POINT_CANDIDATE_ANGLES), the point check reads each, side by
    // side, and the best that points is shown; when none does, the likeliest feeds the next.
    const targetFor = (key: string, sentence: SentenceContent) => {
      const { form, lemma, translation } = kase.items[items.findIndex((item) => item.key === key)];
      return { word: { answer: sentence.sentence.slice(sentence.gap.start, sentence.gap.end), lemma, alternatives: [form] }, meanings: [translation] };
    };
    let asking = pointFaults({ items, verdict, failed }).map((fault) => ({ fault, base: items }));
    for (let round = 1; round <= POINT_REWRITE_ROUNDS && asking.length > 0; round += 1) {
      const next: typeof asking = [];
      await Promise.all(
        asking.map(async ({ fault, base }) => {
          const [ask] = rewriteItems(base, [fault]);
          const candidates = candidateItems(ask);
          const clear = rewriteOthers(items, [fault], []);
          const started = Date.now();
          let reply: LlmDistractors;
          try {
            reply = await askDistractors(sessionLlm, { from, to, items: candidates, learnerWords, others: clear });
          } catch (error) {
            tier1.push({ name: `${fault.key}: the sentence rewrite call succeeded`, ok: false, detail: (error as Error).message });
            return;
          }
          const rescued = validateDistractors(candidates, reply, to, clear, from, nothingKnown());
          const written_ = candidates.flatMap((candidate) => {
            const card = rescued.byKey.get(candidate.key);
            const got = reply.items.find((item) => item.key === candidate.key);
            return card?.sentence && got ? [{ key: candidate.key, card, got, item: pointItem(candidate.key, card.sentence) }] : [];
          });
          written.push(`rewrite ${fault.key} (round ${round}, ${Date.now() - started} ms): ${fault.rewrite.sentence ?? '(none)'} → ${written_.map((one) => one.got.sentence).join(' | ') || '(none usable)'}`);
          if (written_.length === 0) {
            status.set(fault.key, 'the rewrite wrote no usable candidate');
            return;
          }
          const reading = await read(written_.map((one) => one.item), `point check of ${fault.key}'s candidates`);
          const judged = written_.flatMap((one) => {
            const finding = reading.get(one.key);
            if (!finding) return [];
            written.push(`  ${one.key}: ${one.item.sentence} → ${finding.guesses.join(' / ')} (${finding.meaning}, ${finding.readers}/10)`);
            return [{ ...one, finding, verdict: judgePoint(finding, targetFor(fault.key, one.card.sentence!)) }];
          });
          const best = [...judged].sort((a, b) => Number(b.verdict.points) - Number(a.verdict.points) || b.finding.readers - a.finding.readers)[0];
          if (!best) {
            status.set(fault.key, "the point check did not judge the candidates");
            return;
          }
          made.set(fault.key, best.card);
          shown = { items: shown.items.map((item) => (item.key === fault.key ? { ...best.got, key: fault.key } : item)) };
          if (best.verdict.points) {
            status.set(fault.key, null);
            return;
          }
          status.set(fault.key, best.verdict.problem);
          const rewrite = { sentence: best.card.sentence!.sentence, fits: best.verdict.fits, problem: best.verdict.problem };
          next.push({ fault: { key: fault.key, stage: 'pointing', rewrite }, base: [ask] });
        }),
      );
      asking = next;
    }
    const tier2 = items.map((item, index): Check => {
      const why = status.has(item.key) ? status.get(item.key)! : 'no sentence';
      return { name: `${kase.items[index].form}: the point check passes the sentence shown`, ok: why === null, detail: why ?? undefined };
    });
    return { shown, tier1, tier2, written };
  };

  /** Phase 62d (spec D6). The point check alone, on a sentence whose verdict is known. */
  const scorePoint = async (kase: PointCase): Promise<Row> => {
    const text = kase.sentence;
    const item: PointItem = { key: 'p1', sentence: kase.sentence };
    try {
      const finding = readPoint([item], await askPoint(pointLlm, { from: kase.from, to: 'he', items: [item] })).get(item.key);
      if (!finding) return { label: kase.label, text, tier1: [{ name: 'the answer reads', ok: false, detail: 'p1 unanswered' }], tier2: [] };
      const found = judgePoint(finding, { word: { ...kase.word, alternatives: [] }, meanings: kase.meanings });
      const read = `${finding.guesses.join(' / ')} (${finding.meaning}, ${finding.readers}/10)`;
      return {
        label: kase.label,
        text,
        tier1: [{ name: 'the answer reads', ok: true }],
        tier2: [{ name: `${kase.word.answer} ${kase.points ? 'points' : 'does not point'}`, ok: found.points === kase.points, detail: read }],
        written: [read],
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

  // Phase 62c (spec D6). prepareSession's rescue of a gap to choose, through the same domain
  // functions: the gap check on what validation kept, one rewrite of every fault (validation's
  // refusals and the check's short cards), validated as production validates it, and the
  // final check of the rewritten items. A card left with no usable options is a failed check.
  const rescueGaps = async (
    from: LanguageCode,
    to: LanguageCode,
    items: DistractorItem[],
    answer: LlmDistractors,
    learnerWords: LearnerWord[] | undefined,
  ): Promise<{ shown: LlmDistractors; tier1: Check[]; tier2: Check[]; written: string[] }> => {
    const verdict = validateDistractors(items, answer, to, [], from, nothingKnown());
    const optionsOf = (made: Generated) => [...made.distractors, ...made.spares].slice(0, ASKED_DISTRACTORS);
    const gapItemsOf = (made: Map<string, Generated>, keys: readonly string[]): CheckItem[] =>
      keys.flatMap((key) => {
        const card = made.get(key);
        return card?.sentence ? [gapCheckItem(key, card.sentence, optionsOf(card))] : [];
      });
    const gaps = items.filter((item) => item.task === 'gap').map((item) => item.key);
    const ask = async (asked: CheckItem[]) => {
      const started = Date.now();
      const reading = readCheck(asked, await askCheck(llm, { from, to, items: asked }));
      return { reading, ms: Date.now() - started };
    };
    const tier1: Check[] = [];
    const written: string[] = [];
    let judged: GapJudged | null = null;
    const findings = new Map<string, boolean[]>();
    const asked = gapItemsOf(verdict.byKey, gaps);
    if (asked.length > 0) {
      try {
        const { reading, ms } = await ask(asked);
        written.push(`gap check: ${ms} ms`);
        judged = new Map(
          asked.flatMap((item) => {
            const finding = reading.byKey.get(item.key);
            return item.task === 'gap' && finding?.task === 'gap' ? [[item.key, { options: item.options, alsoRight: finding.alsoRight }] as const] : [];
          }),
        );
        for (const [key, found] of judged) findings.set(key, found.alsoRight);
      } catch (error) {
        written.push(`gap check failed: ${(error as Error).message}`);
      }
    }
    const faults = gapFaults({ items, answer, verdict, judged });
    const made = new Map(verdict.byKey);
    let shown = answer;
    const again = new Set<string>();
    if (faults.length > 0) {
      const rewritten = rewriteItems(items, faults);
      const clear = rewriteOthers(items, faults, []);
      const started = Date.now();
      try {
        const reply = await askDistractors(sessionLlm, { from, to, items: rewritten, learnerWords, others: clear });
        written.push(`rewrite: ${Date.now() - started} ms`);
        const rescued = validateDistractors(rewritten, reply, to, clear, from, nothingKnown());
        for (const fault of faults) {
          const got = reply.items.find((item) => item.key === fault.key);
          const options = got?.distractors ?? [];
          tier1.push({ name: `${fault.key}: every rewritten wrong option is in ${from} script`, ok: options.every((text) => isInScript(text, from)), detail: options.join(' | ') });
          const card = rescued.byKey.get(fault.key);
          if (card && got) {
            made.set(fault.key, card);
            again.add(fault.key);
            findings.delete(fault.key);
            shown = { items: shown.items.map((item) => (item.key === fault.key ? got : item)) };
            written.push(`rewrite ${fault.key} (${fault.stage}): ${fault.rewrite.sentence ?? '(none)'} → ${got.sentence ?? '(none)'}`);
          } else {
            written.push(`rewrite ${fault.key} (${fault.stage}) refused: ${rescued.refused.get(fault.key) ?? 'no answer'}`);
          }
        }
      } catch (error) {
        tier1.push({ name: 'the rewrite call succeeded', ok: false, detail: (error as Error).message });
      }
    }
    // The final checker's share: the rewritten items, and those the gap check did not judge.
    const finalKeys = gaps.filter((key) => again.has(key) || !judged?.has(key));
    const finalItems = gapItemsOf(made, finalKeys);
    if (finalItems.length > 0) {
      try {
        const { reading } = await ask(finalItems);
        for (const item of finalItems) {
          const finding = reading.byKey.get(item.key);
          if (finding?.task === 'gap') findings.set(item.key, finding.alsoRight);
        }
      } catch (error) {
        return { shown, tier1, tier2: [{ name: 'the checker answered', ok: false, detail: (error as Error).message }], written };
      }
    }
    const tier2 = gaps.map((key): Check => {
      const name = `${key}: ${KEPT_DISTRACTORS} or more wrong options survive the checker`;
      const card = made.get(key);
      const right = findings.get(key);
      if (!card) return { name, ok: false, detail: `no card after the rescue: ${verdict.refused.get(key) ?? 'no answer'}` };
      if (!right) return { name, ok: false, detail: 'the checker did not judge it' };
      const options = optionsOf(card);
      const left = options.filter((_, at) => !right[at]);
      return { name, ok: left.length >= KEPT_DISTRACTORS, detail: `kept ${left.join(' | ')}; right ${options.filter((_, at) => right[at]).join(' | ') || '(none)'}` };
    });
    return { shown, tier1, tier2, written };
  };

  const scoreFitJudge = async (kase: FitJudgeCase): Promise<Row> => {
    try {
      const verdict = await askFitJudge(judgeLlm, kase);
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

  // Phase 50 (spec D8). Each pair on the side of the server's default line it
  // belongs on. Every score is printed, pass or fail, so the line can be moved
  // with evidence of where same and different actually fall.
  const scoreSoundAlike = async (kase: SoundAlikeCase): Promise<Row> => {
    const text = kase.pairs.map((pair) => `${pair.a}/${pair.b}`).join(', ');
    try {
      const scores = await askSoundAlike(judgeLlm, kase);
      return {
        label: kase.label,
        text,
        tier1: [
          { name: 'the answer parses', ok: scores !== null, detail: scores === null ? 'unreadable' : undefined },
          { name: 'every pair is scored', ok: scores !== null && scores.every((score) => score !== null), detail: scores?.join(', ') },
        ],
        tier2: kase.pairs.map((pair, index) => {
          const score = scores?.[index] ?? null;
          const atLine = score !== null && score >= DEFAULT_SOUND_ALIKE_THRESHOLD;
          return {
            name: `${pair.a}/${pair.b} ${pair.expect}`,
            ok: score !== null && atLine === (pair.expect === 'same'),
            detail: `score ${score ?? 'none'}, line ${DEFAULT_SOUND_ALIKE_THRESHOLD}`,
          };
        }),
        verdict: scores?.map((score) => score ?? 'none').join(', ') ?? undefined,
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

  const scoreTranslationJudge = async (kase: TranslationJudgeCase): Promise<Row> => {
    try {
      const verdict = await askTranslationJudge(translationJudgeLlm, kase);
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

  const scoreExplain = async (kase: ExplainCase): Promise<Row> => {
    try {
      const explained = await askExplain(explainLlm, kase);
      const found = (fix: string) =>
        explained !== null &&
        [explained.corrected, ...explained.mistakes.map((m) => m.right)].some((text) => text.toLowerCase().includes(fix.toLowerCase()));
      const mistakes = explained?.mistakes ?? [];
      return {
        label: kase.label,
        text: kase.answer,
        tier1: [{ name: 'the answer parses', ok: explained !== null, detail: explained === null ? 'unreadable' : undefined }],
        tier2: [
          kase.fixes.length === 0
            ? { name: 'no mistakes', ok: explained !== null && mistakes.length === 0, detail: `${mistakes.length} listed` }
            : { name: 'mistakes listed', ok: mistakes.length > 0, detail: `${mistakes.length} listed` },
          ...kase.fixes.map((fix) => ({ name: `names the fix ${fix}`, ok: found(fix), detail: explained?.corrected })),
          { name: 'every reason in Hebrew', ok: mistakes.every((m) => /[\u0590-\u05FF]/.test(m.why)) },
        ],
        verdict: explained === null ? undefined : mistakes.map((m) => `${m.wrong} → ${m.right} (${m.why})`).join('; ') || 'none',
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

  /** Phase 34. The same contract, for the context call. */
  const scoreContext = async (kase: ContextCase): Promise<Row> => {
    const text = `${kase.form} (${kase.type})`;
    try {
      // Phase 62 (spec D1): with the learner's list, when the case has one.
      const learnerWords = kase.learner?.map((entry, index) => ({ key: `w${index + 1}`, glossId: `g-w${index + 1}`, ...entry }));
      const answer = await askContext(llm, { from: kase.target, to: 'he', items: [contextItemOf(kase)], learnerWords });
      return { label: kase.label, text, tier1: contextTier1(kase, answer), tier2: contextTier2(kase, answer), written: contextWritten(kase, answer) };
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

  /** Phase 34 (spec D5). The same contract, for the checker. */
  const scoreCheck = async (kase: CheckCase): Promise<Row> => {
    const text = `${kase.item.task} ${'word' in kase.item ? kase.item.word : kase.item.sentence}`;
    try {
      const answer = await askCheck(llm, { from: kase.target, to: 'he', items: [kase.item] });
      return { label: kase.label, text, tier1: checkTier1(kase, answer), tier2: checkTier2(kase, answer), written: checkWritten(kase, answer) };
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

  // Every call site of the provider, scored in one run and one scorecard. They
  // share the concurrency budget rather than each taking their own: the quota
  // they compete for is the same one.
  const started = Date.now();
  const [
    translationRows, renderingRows, acceptRows, distractorRows, transcriptionRows, photoRows, matchRows, judgeRows,
    gapRows, sentenceRows, translateRows, tjudgeRows, contextRows, checkRows, fitRows, soundRows, pointRows, explainRows,
  ] = await Promise.all([
    mapWithConcurrency(cases, CONCURRENCY, scoreCase),
    mapWithConcurrency(renderingCases, CONCURRENCY, scoreRendering),
    // Phase 34. Pooled into tier 2 with the translation and rendering rows.
    mapWithConcurrency(acceptCases, CONCURRENCY, scoreAccept),
    mapWithConcurrency(distractorCases, CONCURRENCY, scoreDistractors),
    mapWithConcurrency(transcriptionCases, CONCURRENCY, scoreTranscription),
    mapWithConcurrency(photoCases, CONCURRENCY, scorePhoto),
    mapWithConcurrency(matchCases, CONCURRENCY, scoreMatch),
    mapWithConcurrency(judgeCases, CONCURRENCY, scoreJudge),
    mapWithConcurrency(gapCases, CONCURRENCY, scoreSentences),
    mapWithConcurrency(sentenceCases, CONCURRENCY, scoreSentences),
    mapWithConcurrency(translateCases, CONCURRENCY, scoreSentences),
    mapWithConcurrency(tjudgeCases, CONCURRENCY, scoreTranslationJudge),
    mapWithConcurrency(contextCases, CONCURRENCY, scoreContext),
    mapWithConcurrency(checkCases, CONCURRENCY, scoreCheck),
    mapWithConcurrency(fitCases, CONCURRENCY, scoreFitJudge),
    mapWithConcurrency(soundCases, CONCURRENCY, scoreSoundAlike),
    mapWithConcurrency(pointCases, CONCURRENCY, scorePoint),
    mapWithConcurrency(explainCases, CONCURRENCY, scoreExplain),
  ]);
  const rows = [
    ...translationRows, ...renderingRows, ...acceptRows, ...distractorRows, ...transcriptionRows, ...photoRows, ...matchRows,
    ...judgeRows, ...gapRows, ...sentenceRows, ...translateRows, ...tjudgeRows, ...contextRows, ...checkRows, ...fitRows, ...soundRows, ...pointRows, ...explainRows,
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
  // Each Part B group has a line of its own for the same reason: a good score in
  // one must not hide a drop in another.
  const groups = [
    { name: 'gap', rows: gapRows, passed: 0, total: 0 },
    { name: 'sentence', rows: [...sentenceRows, ...translateRows], passed: 0, total: 0 },
    { name: 'translation judge', rows: tjudgeRows, passed: 0, total: 0 },
    // Phase 34. The context call, a line of its own like the others.
    { name: 'context', rows: contextRows, passed: 0, total: 0 },
    // Phase 34 (spec D5). The checker, a line of its own: a checker that says
    // yes to everything must fail here, not hide in the pooled score.
    { name: 'checker', rows: checkRows, passed: 0, total: 0 },
    // Phase 41 (spec D2). The fit check, a line of its own: a judge that says
    // fits to everything must fail here.
    { name: 'fit judge', rows: fitRows, passed: 0, total: 0 },
    // Phase 50 (spec D8). The sound-alike score, a line of its own: a scorer
    // that calls every near miss the same word must fail here.
    { name: 'sound alike', rows: soundRows, passed: 0, total: 0 },
    // Phase 62d (spec D6). The point check, a line of its own: a reader who calls every
    // sentence clear, or none, must fail here.
    { name: 'pointing check', rows: pointRows, passed: 0, total: 0 },
    // Phase 66 (spec D2). The explainer, a line of its own: one that finds a
    // mistake in every sentence, or in none, must fail here.
    { name: 'explain', rows: explainRows, passed: 0, total: 0 },
  ];

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
    } else if (groups.some((group) => group.rows.includes(row))) {
      const group = groups.find((candidate) => candidate.rows.includes(row))!;
      group.passed += passed;
      group.total += row.tier2.length;
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
    for (const line of row.written ?? []) console.log(`       ${line}`);
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
    if (row.accept) {
      console.log(
        `       answers=${row.accept.raw.answers.join(' | ') || '(none)'} answer_form=${row.accept.raw.answer_form ?? 'null'}` +
          ` kept=${row.accept.answers.join(' | ') || '(none)'}`,
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
  const groupScore = (group: { passed: number; total: number }) => (group.total === 0 ? 0 : group.passed / group.total);
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
      groups
        .map(
          (group) =>
            `${group.name} tier 2: ${group.passed}/${group.total} = ${((groupScore(group)) * 100).toFixed(1)}% ` +
            `(threshold ${(TIER2_THRESHOLD * 100).toFixed(0)}%)\n`,
        )
        .join('') +
      `${cases.length} translation + ${renderingCases.length} rendering + ${acceptCases.length} accept + ${distractorCases.length} distractor + ${transcriptionCases.length} transcription + ` +
      `${photoCases.length} photo + ${matchCases.length} match + ${judgeCases.length} judge + ` +
      `${gapCases.length} gap + ${sentenceCases.length} sentence + ${translateCases.length} translate + ${tjudgeCases.length} translation judge + ` +
      `${contextCases.length} context + ${checkCases.length} checker + ${fitCases.length} fit judge + ${soundCases.length} sound alike + ` +
      `${pointCases.length} pointing check + ${explainCases.length} explain cases in ` +
      `${(elapsedMs / 1000).toFixed(1)}s ` +
      `at concurrency ${CONCURRENCY}`,
  );

  // Gitignored, so a prompt change can be diffed against the previous run
  // instead of judged from memory.
  const dir = join(__dirname, '.results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        model: gemini.model,
        score,
        transcriptionScore,
        photoScore,
        judgeScore,
        gapScore: groupScore(groups[0]),
        sentenceScore: groupScore(groups[1]),
        translationJudgeScore: groupScore(groups[2]),
        contextScore: groupScore(groups[3]),
        checkerScore: groupScore(groups[4]),
        fitJudgeScore: groupScore(groups[5]),
        soundAlikeScore: groupScore(groups[6]),
        pointingScore: groupScore(groups[7]),
        rows,
      },
      null,
      2,
    ),
  );
  console.log(`report: ${file}`);

  // A group with no checks (a filtered run) has nothing to fail on.
  const belowThreshold = (total: number, value: number) => total > 0 && value < TIER2_THRESHOLD;
  if (
    tier1Failures > 0 ||
    belowThreshold(tier2Total, score) ||
    belowThreshold(speechTotal, transcriptionScore) ||
    belowThreshold(photoTotal, photoScore) ||
    belowThreshold(judgeTotal, judgeScore) ||
    groups.some((group) => belowThreshold(group.total, groupScore(group)))
  ) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
