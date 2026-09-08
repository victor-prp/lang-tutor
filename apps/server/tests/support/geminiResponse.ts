/**
 * The Gemini `generateContent` response envelope, built from the JSON the model
 * is pretending to have produced. A test declares senses; this puts them where
 * the real API puts them, so `providers/gemini.ts` is exercised for real.
 *
 * Repo code, but it runs in the test process — never inside the shared
 * container — so two checkouts cannot disagree about it.
 */
export function geminiResponse(payload: unknown) {
  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ text: JSON.stringify(payload) }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  };
}

/** A safety-blocked response: no candidate at all. Maps to an empty sense list. */
export function geminiBlockedResponse() {
  return { promptFeedback: { blockReason: 'SAFETY', safetyRatings: [] } };
}
