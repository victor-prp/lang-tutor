import { z, type ZodType } from 'zod';

import { LlmUnavailable } from '../errors';

/**
 * The only outbound HTTP in this repository (ADR 0001 R10/R11). It knows about
 * Gemini's request shape, its response envelope and its schema dialect, and
 * nothing about translation: no senses, no directions, no `kind`.
 *
 * Raw `fetch` rather than `@google/genai`, because the SDK reads
 * GEMINI_API_KEY from the environment itself, which ADR 0002 R2 forbids outside
 * a composition root.
 *
 * Note there is no `: LlmClient` annotation. That type lives in `services/`,
 * which R10 forbids importing; the assignment is checked in `composition.ts`,
 * exactly as `db/transaction.ts` leaves `Transaction` to be checked there.
 */

// Keys Zod emits that Gemini's Schema type does not accept. Measured, not
// guessed: z.toJSONSchema emits `$schema` at the root and
// `additionalProperties: false` on every object. OpenAI's strict mode wants the
// second one *kept*, which is exactly why this conversion belongs to a provider
// rather than to the caller.
const UNSUPPORTED_KEYS = ['$schema', 'additionalProperties'] as const;

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node as Record<string, unknown>)
      .filter(([key]) => !UNSUPPORTED_KEYS.includes(key as (typeof UNSUPPORTED_KEYS)[number]))
      .map(([key, value]) => [key, strip(value)]),
  );
}

export function toGeminiSchema(schema: ZodType): Record<string, unknown> {
  return strip(z.toJSONSchema(schema)) as Record<string, unknown>;
}

export function createGeminiClient(deps: {
  fetch: typeof globalThis.fetch;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}) {
  const endpoint = `${deps.baseUrl}/v1beta/models/${deps.model}:generateContent`;

  return async (request: { system: string; user: string; schema: ZodType }): Promise<string> => {
    // One budget for the whole call. No retry: a learner who taps retry *is*
    // the retry, and three sequential ten-second waits would be worse than one.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs);

    let response: Response;
    try {
      response = await deps.fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // A header, never `?key=`: a query parameter puts the secret into
          // URLs, access logs and any intermediary proxy.
          'x-goog-api-key': deps.apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: 'user', parts: [{ text: request.user }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: toGeminiSchema(request.schema),
          },
        }),
        signal: controller.signal,
      });
    } catch {
      // Abort and network failure arrive here identically. The message names the
      // cause and never the key.
      throw new LlmUnavailable(
        controller.signal.aborted ? `timed out after ${deps.timeoutMs}ms` : 'network failure',
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw new LlmUnavailable(`responded ${response.status}`);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new LlmUnavailable('response body was not JSON');
    }

    // A safety block arrives as promptFeedback.blockReason with no candidate.
    // Empty string is the contract's "no content" — the input was refused, the
    // provider was not broken.
    const text = (body as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] })
      ?.candidates?.[0]?.content?.parts?.[0]?.text;
    return typeof text === 'string' ? text : '';
  };
}
