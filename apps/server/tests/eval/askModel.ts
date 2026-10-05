import type {
  LanguageCode,
  LlmDistractors,
  LlmEntry,
  LlmReconciliation,
  PartOfSpeech,
  TranslationCorrection,
  TranslationKind,
  TranslationSense,
} from '@lang-tutor/core/api';

import {
  buildDistractorPrompt,
  parseLlmDistractors,
  type DistractorItem,
} from '../../src/domain/distractors';
import {
  buildPrompt,
  buildRenderingPrompt,
  normalizeSenses,
  parseLlmReconciliation,
  parseLlmTranslation,
  resolveCorrection,
  resolveKind,
  type StoredSense,
} from '../../src/domain/translation';
import { flattenEntries, mergeEntries, normalizeForm } from '../../src/domain/dictionary';
import type { LlmClient } from '../../src/services/llm';

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

  const raw = await llm(buildPrompt({ text, from, to }));
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
    senses: normalizeSenses(kind, flattenEntries(entries)),
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
  const raw = await llm(buildRenderingPrompt(input));
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
  input: { from: LanguageCode; to: LanguageCode; items: DistractorItem[] },
): Promise<LlmDistractors> {
  const raw = await llm(buildDistractorPrompt(input));
  const answer = raw === '' ? null : parseLlmDistractors(raw);
  if (!answer) throw new Error(`unreadable distractor answer: ${raw.slice(0, 200)}`);
  return answer;
}
