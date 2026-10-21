import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LlmTranscriptSchema } from '@lang-tutor/core/api/schemas';
import type {
  ClozeTypedQuestion,
  LanguageCode,
  LlmAccept,
  LlmCheck,
  LlmContext,
  TypedVerdict,
  LlmDistractors,
  LlmEntry,
  LlmPoint,
  LlmReconciliation,
  PartOfSpeech,
  SentenceTranslationQuestion,
  TranslationCorrection,
  TranslationKind,
  TranslationSense,
} from '@lang-tutor/core/api';

import { buildAcceptPrompt, parseAccept, validateAccept, type AcceptInput } from '../../src/domain/accept';
import { buildCheckPrompt, parseCheck, type CheckItem } from '../../src/domain/check';
import { buildContextPrompt, parseLlmContext, type ContextItem } from '../../src/domain/context';
import { buildDiscoveryPrompt, parseDiscovery, wordKey, type DiscoveryPromptInput } from '../../src/domain/discovery';
import { buildExplainPrompt, parseExplain, type Explanation } from '../../src/domain/explain';
import {
  buildDistractorPrompt,
  parseLlmDistractors,
  type DistractorItem,
  type LearnerWord,
  type OtherRow,
} from '../../src/domain/distractors';
import {
  buildFitJudgePrompt,
  buildMeaningJudgePrompt,
  buildTranslationJudgePrompt,
  parseFitJudge,
  parseMeaningJudge,
  parseTranslationJudge,
  type JudgeContext,
  type MeaningJudgeContext,
} from '../../src/domain/judge';
import { buildPointPrompt, parsePoint, type PointItem } from '../../src/domain/pointing';
import { parseTranscript, transcriptionSystem } from '../../src/domain/speech';
import type { SpeechTranscriber } from '../../src/services/speech';
import {
  buildPrompt,
  buildRenderingPrompt,
  normalizeSenses,
  parseLlmReconciliation,
  parseLlmTranslation,
  resolveCorrection,
  resolveKind,
  unfence,
  type StoredSense,
} from '../../src/domain/translation';
import { flattenEntries, mergeEntries, normalizeForm } from '../../src/domain/dictionary';
import { LANGUAGES } from '../../src/domain/languages';
import { buildSoundAlikePrompt, orderedPair, parseSoundAlike } from '../../src/domain/soundAlike';
import type { LlmClient } from '../../src/services/llm';
import { z } from 'zod';

/**
 * The real prompt, the real client, the real parser — everything
 * `services/translations.ts` does to an answer *except* touch a database.
 *
 * It stops short of the service on purpose. As of phase 10 the service reads
 * Postgres before it calls the provider and writes to it afterwards, and this
 * bucket has neither a database nor any business having one: the object under
 * test is the prompt. Going through the service would mean handing it a fake
 * transaction that reimplemented the merge, which is the one piece of logic a
 * fake must never own.
 *
 * It also exposes `entries`, which the response deliberately flattens away —
 * and the entries are exactly what the phase 10 tiers score.
 */
export type ModelAnswer = {
  from: LanguageCode;
  to: LanguageCode;
  kind: TranslationKind;
  entries: LlmEntry[];
  senses: TranslationSense[];
  /** Phase 13. Exposed alongside `entries`, which the wire flattens away, and for
   *  the same reason: it is what the correction cases score. */
  correction?: TranslationCorrection;
};

export async function askModel(
  llm: LlmClient,
  input: { text: string; from: LanguageCode; to: LanguageCode },
): Promise<ModelAnswer> {
  const text = input.text.trim();
  const { from, to } = input;

  const raw = await llm({ ...buildPrompt({ text, from, to }), record: { kind: 'lookup' } });
  // An empty string is the contract's "no content" — a safety block, or a
  // candidate with no text. The input was refused; nothing is broken.
  if (raw === '') return { from, to, kind: resolveKind(text, 'word'), entries: [], senses: [] };

  const parsed = parseLlmTranslation(raw);
  if (!parsed) throw new Error('the model response did not match the expected shape');

  // The service's step 4, verbatim. `kind` comes out of here computed against the
  // EFFECTIVE form, so it is the kind the server would actually have written onto
  // dict_variants — which is the only version of it worth scoring.
  const resolved = resolveCorrection(parsed, { typedForm: normalizeForm(text), from, to });
  if (!resolved) throw new Error('the correction named a form in the other script');
  const { correction, kind } = resolved;

  const entries = mergeEntries(parsed.entries);
  return {
    from,
    to,
    kind,
    entries,
    senses: normalizeSenses(kind, flattenEntries(entries, kind)),
    ...(correction ? { correction } : {}),
  };
}

/**
 * The **second** call, which `askModel` above does not reach: the reconciliation
 * that renders a stored lexeme's senses for a newly queried form.
 *
 * It was unscored until the phase 12 follow-ups, and that is precisely how `pressing` shipped
 * returning the same meaning twice. `askModel` stops at `buildPrompt`, so every
 * case in this bucket was scoring the entry split — the half that was already
 * working — while the half that invents sense codes and writes them into a
 * dictionary with no TTL had no real-model coverage at all.
 *
 * It takes the stored senses as a literal rather than reading them from
 * Postgres, for the same reason `askModel` stops short of the service: the
 * object under test is the prompt, and this bucket has no database.
 */
export async function askRendering(
  llm: LlmClient,
  input: {
    form: string;
    from: LanguageCode;
    to: LanguageCode;
    lemma: string;
    partOfSpeech: PartOfSpeech;
    storedSenses: StoredSense[];
  },
): Promise<LlmReconciliation> {
  const raw = await llm({ ...buildRenderingPrompt(input), record: { kind: 'rendering' } });
  // Unlike call 1, an empty answer here is not "the input was refused" — the
  // input is a form the model already returned an entry for. It is a failure.
  if (raw === '') throw new Error('the model returned no content for the rendering call');

  const parsed = parseLlmReconciliation(raw);
  if (!parsed) throw new Error('the rendering response did not match the expected shape');
  return parsed;
}

/** Phase 19. The real distractor prompt and parser, as prepareSession uses
 *  them, minus the database. Throws on an unreadable answer: tier 1 then
 *  records it as a failed call. */
export async function askDistractors(
  llm: LlmClient,
  // Phase 62c (spec D6): a rewrite names what it must keep clear of, as prepareSession's does.
  input: { from: LanguageCode; to: LanguageCode; items: DistractorItem[]; learnerWords?: LearnerWord[]; others?: OtherRow[] },
): Promise<LlmDistractors> {
  const raw = await llm({ ...buildDistractorPrompt({ ...input, others: input.others ?? [] }), record: { kind: input.others ? 'gap_rewrite' : 'session_generation' } });
  const answer = raw === '' ? null : parseLlmDistractors(raw);
  if (!answer) throw new Error(`unreadable distractor answer: ${raw.slice(0, 200)}`);
  return answer;
}

/** Phase 25. The real instruction and the real parser over one clip — what
 *  answerBySpeech does to it, without a database. Null when unreadable. */
export async function askTranscription(
  transcriber: SpeechTranscriber,
  input: { file: string; language: 'it' | 'ru' | 'en' },
): Promise<string | null> {
  const audio = readFileSync(join(__dirname, 'audio', `${input.file}.aac`)).toString('base64');
  const raw = await transcriber({
    system: transcriptionSystem(input.language),
    audio,
    mimeType: 'audio/aac',
    schema: LlmTranscriptSchema,
    record: { kind: 'transcription' },
  });
  return parseTranscript(raw);
}

/** Phase 27. The real meaning-judge prompt and parser over one answer — what
 *  answerJudged sends when no rule decides. Null when unreadable. */
export async function askTranslationJudge(
  llm: LlmClient,
  kase: { question: SentenceTranslationQuestion; context: JudgeContext; answer: string },
): Promise<TypedVerdict | null> {
  return parseTranslationJudge(
    await llm({ ...buildTranslationJudgePrompt(kase.question, kase.context, kase.answer), record: { kind: 'translation_judge' } }),
  );
}

/** Phase 66 (spec D2). The real explain prompt and parser over one answer, as
 *  explainAnswer sends it when no rule decides. Null when unreadable. */
export async function askExplain(
  llm: LlmClient,
  kase: { question: SentenceTranslationQuestion; context: JudgeContext; answer: string },
): Promise<Explanation | null> {
  return parseExplain(await llm({ ...buildExplainPrompt(kase.question, kase.context, kase.answer), record: { kind: 'sentence_explain' } }));
}

/** Phase 69 (spec D4). The real round prompt and parser, as nextRound calls them: the raw
 *  answer too, so a case can see what the parser dropped. */
export async function askDiscovery(
  llm: LlmClient,
  kase: { input: DiscoveryPromptInput },
): Promise<{ raw: string; parsed: ReturnType<typeof parseDiscovery> }> {
  const raw = await llm({ ...buildDiscoveryPrompt(kase.input), record: { kind: 'discovery' } });
  return { raw, parsed: parseDiscovery(raw, new Set(kase.input.exclude.map(wordKey))) };
}

/** Phase 50 (spec D2). The real sound-alike prompt and parser, as answerBySpeech
 *  calls them: each pair ordered as it is stored, one call for all of them. */
export async function askSoundAlike(
  llm: LlmClient,
  kase: { language: LanguageCode; pairs: { a: string; b: string }[] },
): Promise<(number | null)[] | null> {
  const pairs = kase.pairs.map(({ a, b }) => orderedPair({ heard: a, form: b }));
  return parseSoundAlike(await llm({ ...buildSoundAlikePrompt(kase.language, pairs), record: { kind: 'sound_alike' } }), pairs.length);
}

/** Phase 41 (spec D2). The real fit prompt and parser, as answerText calls them. */
export async function askFitJudge(
  llm: LlmClient,
  kase: { question: ClozeTypedQuestion; language: LanguageCode; answer: string },
): Promise<'fits' | 'wrong' | null> {
  return parseFitJudge(await llm({ ...buildFitJudgePrompt(kase.question, kase.language, kase.answer), record: { kind: 'fit_judge' } }));
}

const GapGuessesSchema = z.object({ guesses: z.array(z.string()) });

/**
 * Phase 41 (spec D1). The eval's own probe, no call the app makes: the three
 * words a reader would most likely put in a gapped sentence read alone. A
 * sentence that points to its word has that word, or one of its meaning, here.
 */
export async function askGapGuesses(llm: LlmClient, kase: { language: LanguageCode; sentence: string }): Promise<string[]> {
  const raw = await llm({
    system: [
      `A ${LANGUAGES[kase.language].name} sentence has one word left out, marked ___.`,
      'Return JSON only, matching the supplied schema: in guesses, the three words a native reader would most likely put in the gap, likeliest first, each in the form the gap needs.',
    ].join('\n'),
    user: JSON.stringify({ sentence: kase.sentence }),
    schema: GapGuessesSchema,
    // An eval-only probe with no production twin; the eval records nothing (phase 47 R6).
    record: { kind: 'fit_judge' },
  });
  const parsed = GapGuessesSchema.safeParse(JSON.parse(unfence(raw)));
  return parsed.success ? parsed.data.guesses.slice(0, 3) : [];
}

export async function askJudge(
  llm: LlmClient,
  kase: { context: MeaningJudgeContext; answer: string },
): Promise<TypedVerdict | null> {
  return parseMeaningJudge(await llm({ ...buildMeaningJudgePrompt(kase.context, kase.answer), record: { kind: 'judge' } }));
}

/** Phase 34 (spec D1, D2). The real accept prompt, parser and validation, as the
 *  accept job uses them, minus the database. `raw` is the answer as the model
 *  wrote it, which the placeholder check reads; `answers` and `answerForm` are
 *  what the server would store. An empty answer is the provider's "no content",
 *  stored as an empty list; an unreadable one throws, and tier 1 records it. */
export async function askAccept(
  llm: LlmClient,
  input: AcceptInput,
): Promise<{ raw: LlmAccept; answers: string[]; answerForm: string | null }> {
  const text = await llm({ ...buildAcceptPrompt(input), record: { kind: 'accept' } });
  const raw = text === '' ? { answers: [], answer_form: null } : parseAccept(text);
  if (!raw) throw new Error(`unreadable accept answer: ${text.slice(0, 200)}`);
  return { raw, ...validateAccept(input, raw) };
}

/** Phase 34 (spec D6, D8; ruling R8). The real context prompt and parser, as
 *  prepareSession sends them after the batch, minus the database. Throws on an
 *  empty or unreadable answer: tier 1 then records it as a failed call (the
 *  session would go on without it, ruling R11, but the prompt has failed). */
export async function askContext(
  llm: LlmClient,
  input: { from: LanguageCode; to: LanguageCode; items: ContextItem[]; learnerWords?: readonly LearnerWord[] },
): Promise<LlmContext> {
  const raw = await llm({ ...buildContextPrompt(input), record: { kind: 'context' } });
  const answer = raw === '' ? null : parseLlmContext(raw);
  if (!answer) throw new Error(`unreadable context answer: ${raw.slice(0, 200)}`);
  return answer;
}

/** Phase 34 (spec D5). The real checker prompt and parser, as prepareSession
 *  sends them after the context call, minus the database. Throws on an empty or
 *  unreadable answer: the session would fail the attempt on it too. */
/** Phase 62d (spec D2). The real point check, prompt and parser, as prepareSession calls it. */
export async function askPoint(llm: LlmClient, input: { from: LanguageCode; to: LanguageCode; items: PointItem[] }): Promise<LlmPoint> {
  const raw = await llm({ ...buildPointPrompt(input.items, input.from, input.to), record: { kind: 'gap_point' } });
  const answer = raw === '' ? null : parsePoint(raw);
  if (!answer) throw new Error(`unreadable point check answer: ${raw.slice(0, 200)}`);
  return answer;
}

export async function askCheck(
  llm: LlmClient,
  input: { from: LanguageCode; to: LanguageCode; items: CheckItem[] },
): Promise<LlmCheck> {
  const raw = await llm({ ...buildCheckPrompt(input.items, input.from, input.to), record: { kind: 'checker' } });
  const answer = raw === '' ? null : parseCheck(raw);
  if (!answer) throw new Error(`unreadable checker answer: ${raw.slice(0, 200)}`);
  return answer;
}
