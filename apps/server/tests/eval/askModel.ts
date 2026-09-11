import type {
  LlmEntry,
  TranslationDirection,
  TranslationKind,
  TranslationSense,
} from '@lang-tutor/core/api';

import {
  buildPrompt,
  detectDirection,
  normalizeSenses,
  parseLlmTranslation,
  resolveKind,
} from '../../src/domain/translation';
import { flattenEntries, mergeEntries } from '../../src/domain/vocabulary';
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
