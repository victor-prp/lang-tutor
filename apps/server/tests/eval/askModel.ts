import type {
  LlmEntry,
  LlmReconciliation,
  PartOfSpeech,
  TranslationDirection,
  TranslationKind,
  TranslationSense,
} from '@lang-tutor/core/api';

import {
  buildPrompt,
  buildRenderingPrompt,
  detectDirection,
  normalizeSenses,
  parseLlmReconciliation,
  parseLlmTranslation,
  resolveKind,
  type StoredSense,
} from '../../src/domain/translation';
import { flattenEntries, mergeEntries } from '../../src/domain/dictionary';
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
  direction: TranslationDirection;
  kind: TranslationKind;
  entries: LlmEntry[];
  senses: TranslationSense[];
};

export async function askModel(
  llm: LlmClient,
  input: { text: string; direction?: TranslationDirection },
): Promise<ModelAnswer> {
  const text = input.text.trim();
  const direction = input.direction ?? detectDirection(text);

  const raw = await llm(buildPrompt({ text, direction }));
  // An empty string is the contract's "no content" — a safety block, or a
  // candidate with no text. The input was refused; nothing is broken.
  if (raw === '') return { direction, kind: resolveKind(text, 'word'), entries: [], senses: [] };

  const parsed = parseLlmTranslation(raw);
  if (!parsed) throw new Error('the model response did not match the expected shape');

  const kind = resolveKind(text, parsed.kind);
  const entries = mergeEntries(parsed.entries);
  return { direction, kind, entries, senses: normalizeSenses(kind, flattenEntries(entries)) };
}

/**
 * The **second** call, which `askModel` above does not reach: the reconciliation
 * that renders a stored lexeme's senses for a newly queried form.
 *
 * It was unscored until phase 13, and that is precisely how `pressing` shipped
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
    direction: TranslationDirection;
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
