import { z, type ZodType } from 'zod';

import { LlmUnavailable } from '../errors';

/**
 * The only outbound HTTP in this repository (ADR 0001 R10/R11). It knows about
 * Gemini's request shape, its response envelope and its schema dialect, and
 * nothing about translation: no senses, no directions, no `kind`. Since phase 25
 * it also carries an audio call (createGeminiTranscriber).
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

type GeminiDeps = {
  fetch: typeof globalThis.fetch;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
};

/** One generateContent call and its envelope: the budget, the key header, the
 *  failure mapping and the first candidate's text ('' for none). */
async function generate(deps: GeminiDeps, body: Record<string, unknown>): Promise<string> {
  const endpoint = `${deps.baseUrl}/v1beta/models/${deps.model}:generateContent`;
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
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // Abort and network failure arrive here identically. The message names the
    // cause and never the key.
    throw new LlmUnavailable(controller.signal.aborted ? `timed out after ${deps.timeoutMs}ms` : 'network failure');
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw new LlmUnavailable(`responded ${response.status}`);

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new LlmUnavailable('response body was not JSON');
  }

  // A safety block arrives as promptFeedback.blockReason with no candidate.
  // Empty string is the contract's "no content" — the input was refused, the
  // provider was not broken.
  const text = (json as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] })?.candidates?.[0]?.content
    ?.parts?.[0]?.text;
  return typeof text === 'string' ? text : '';
}

export function createGeminiClient(deps: GeminiDeps) {
  return (request: { system: string; user: string; schema: ZodType }): Promise<string> =>
    generate(deps, {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: 'user', parts: [{ text: request.user }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(request.schema),
      },
    });
}

/**
 * Phase 25 (spec D13). The same provider over one audio clip. Thinking is off:
 * transcribing a word gains nothing from reasoning, and the POC measured it as
 * about 0.3 s of every call. `thinkingBudget` is the 2.5 family's field
 * (GEMINI_MODEL is gemini-2.5-flash); a change of model re-checks it.
 */
export function createGeminiTranscriber(deps: GeminiDeps) {
  return (request: { system: string; audio: string; mimeType: string; schema: ZodType }): Promise<string> =>
    generate(deps, {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: request.mimeType, data: request.audio } }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(request.schema),
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
}

/**
 * Phase 26 (spec D5). The same call with a photo in the user turn: the image
 * part first, then the text. Its own factory, because widening LlmClient for an
 * image would widen it for every caller. Wired only in composition.ts, where
 * the `: VisionClient` annotation checks it.
 */
export function createGeminiVisionClient(deps: GeminiDeps) {
  return (request: {
    system: string;
    user: string;
    schema: ZodType;
    image: { data: string; mimeType: string };
  }): Promise<string> =>
    generate(deps, {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: request.image.mimeType, data: request.image.data } }, { text: request.user }],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(request.schema),
      },
    });
}
