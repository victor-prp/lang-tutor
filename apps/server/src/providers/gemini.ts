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

/**
 * Phase 47 (spec D4). One request as this provider saw it, reported once
 * whatever its outcome. The record is the caller's, passed through untouched:
 * this layer neither reads nor shapes it. Satisfies services/llm.ts's ModelCall
 * structurally; composition.ts is where that is checked (ADR 0001 R10, R11).
 */
export type GeminiCall<R> = {
  record: R;
  model: string;
  startedAt: Date;
  request: unknown;
  response: unknown;
  httpStatus: number | null;
  error: string | null;
  durationMs: number;
  promptTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  finishReason: string | null;
};

type GeminiDeps<R> = {
  fetch: typeof globalThis.fetch;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  // A setting, not a collaborator (ADR 0002 R5). Phase 27: 0 turns thinking off.
  thinkingBudget?: number;
  // Phase 47 (spec D4). Told about every request, after it ended and before
  // its answer is returned or its failure thrown. It never throws (spec D5).
  onCall: (call: GeminiCall<R>) => Promise<void>;
  // Phase 47 (review, ADR 0002). The clock a call is timed by: received, so
  // the record's start and the recorder's prune read the same one.
  now: () => number;
};

type Envelope = {
  candidates?: { content?: { parts?: { text?: unknown }[] }; finishReason?: unknown }[];
  usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; thoughtsTokenCount?: unknown };
};

const count = (value: unknown): number | null => (typeof value === 'number' ? value : null);

/** Phase 47 (spec D4, ruling R5). A body as recorded: each inline clip or photo
 *  replaced by its type and decoded size, so no media reaches the record. */
function withoutMedia(body: Record<string, unknown>): Record<string, unknown> {
  const contents = body.contents as { role: string; parts: Record<string, unknown>[] }[];
  return {
    ...body,
    contents: contents.map((content) => ({
      ...content,
      parts: content.parts.map((part) => {
        const inline = part.inlineData as { mimeType: string; data: string } | undefined;
        if (!inline) return part;
        const padding = inline.data.endsWith('==') ? 2 : inline.data.endsWith('=') ? 1 : 0;
        return { inlineData: { mimeType: inline.mimeType, bytes: (inline.data.length * 3) / 4 - padding } };
      }),
    })),
  };
}

/** One generateContent call and its envelope: the budget, the key header, the
 *  failure mapping and the first candidate's text ('' for none). Since phase 47
 *  it reports the call to `onCall` however it ends. */
async function generate<R>(deps: GeminiDeps<R>, record: R, body: Record<string, unknown>): Promise<string> {
  const endpoint = `${deps.baseUrl}/v1beta/models/${deps.model}:generateContent`;
  const startedAt = new Date(deps.now());
  const report = (outcome: { response: unknown; httpStatus: number | null; error: string | null }) => {
    const envelope = (outcome.response ?? {}) as Envelope;
    const usage = envelope.usageMetadata ?? {};
    const finish = envelope.candidates?.[0]?.finishReason;
    return deps.onCall({
      record,
      model: deps.model,
      startedAt,
      request: withoutMedia(body),
      ...outcome,
      durationMs: deps.now() - startedAt.getTime(),
      promptTokens: count(usage.promptTokenCount),
      outputTokens: count(usage.candidatesTokenCount),
      thinkingTokens: count(usage.thoughtsTokenCount),
      finishReason: typeof finish === 'string' ? finish : null,
    });
  };
  // One budget for the whole call. No retry: a learner who taps retry *is*
  // the retry, and three sequential ten-second waits would be worse than one.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);

  let response: Response;
  let text: string;
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
    // Read inside the budget: a body that stalls is as late as a header that does.
    text = await response.text();
  } catch {
    // Abort and network failure arrive here identically. The message names the
    // cause and never the key.
    const error = controller.signal.aborted ? `timed out after ${deps.timeoutMs}ms` : 'network failure';
    await report({ response: null, httpStatus: null, error });
    throw new LlmUnavailable(error);
  } finally {
    clearTimeout(timer);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    const error = response.ok ? 'response body was not JSON' : `responded ${response.status}`;
    await report({ response: { text }, httpStatus: response.status, error });
    throw new LlmUnavailable(error);
  }

  if (!response.ok) {
    const error = `responded ${response.status}`;
    await report({ response: json, httpStatus: response.status, error });
    throw new LlmUnavailable(error);
  }
  await report({ response: json, httpStatus: response.status, error: null });

  // A safety block arrives as promptFeedback.blockReason with no candidate.
  // Empty string is the contract's "no content" — the input was refused, the
  // provider was not broken.
  const answer = (json as Envelope)?.candidates?.[0]?.content?.parts?.[0]?.text;
  return typeof answer === 'string' ? answer : '';
}

export function createGeminiClient<R>(deps: GeminiDeps<R>) {
  return (request: { system: string; user: string; schema: ZodType; record: R }): Promise<string> =>
    generate(deps, request.record, {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: 'user', parts: [{ text: request.user }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(request.schema),
        ...(deps.thinkingBudget === undefined ? {} : { thinkingConfig: { thinkingBudget: deps.thinkingBudget } }),
      },
    });
}

/**
 * Phase 25 (spec D13). The same provider over one audio clip. Thinking is off:
 * transcribing a word gains nothing from reasoning, and the POC measured it as
 * about 0.3 s of every call. `thinkingBudget` is the 2.5 family's field
 * (GEMINI_MODEL is gemini-2.5-flash); a change of model re-checks it.
 */
export function createGeminiTranscriber<R>(deps: GeminiDeps<R>) {
  return (request: { system: string; audio: string; mimeType: string; schema: ZodType; record: R }): Promise<string> =>
    generate(deps, request.record, {
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
export function createGeminiVisionClient<R>(deps: GeminiDeps<R>) {
  return (request: {
    system: string;
    user: string;
    schema: ZodType;
    image: { data: string; mimeType: string };
    record: R;
  }): Promise<string> =>
    generate(deps, request.record, {
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
