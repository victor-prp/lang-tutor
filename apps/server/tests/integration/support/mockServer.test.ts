import { describe, expect, it, afterEach } from '@jest/globals';

import {
  assertMockServerReachable,
  clearNamespace,
  expectGeminiJson,
  expectGeminiStatus,
  geminiBaseUrlFor,
  mockNamespace,
  verifyGeminiHeader,
} from '../../support/mockServer';

// Exercises the harness itself, not application code — the same reason
// tests/integration/support/isolation.test.ts exists. ADR 0004 R6 covers it.
describe('the MockServer helper', () => {
  const namespaces: string[] = [];
  const ns = (label: string) => {
    const value = mockNamespace(label);
    namespaces.push(value);
    return value;
  };

  afterEach(async () => {
    await Promise.all(namespaces.splice(0).map(clearNamespace));
  });

  it('is reachable', async () => {
    await expect(assertMockServerReachable()).resolves.toBeUndefined();
  });

  it('serves a registered Gemini response inside its own namespace', async () => {
    const namespace = ns('serves');
    await expectGeminiJson(namespace, {
      kind: 'word',
      senses: [{ translation: 'ספר', part_of_speech: 'noun' }],
    });

    const res = await fetch(
      `${geminiBaseUrlFor(namespace)}/v1beta/models/test-model:generateContent`,
      { method: 'POST', headers: { 'x-goog-api-key': 'k' }, body: JSON.stringify({ q: 'book' }) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: { content: { parts: { text: string }[] } }[] };
    expect(JSON.parse(body.candidates[0].content.parts[0].text)).toEqual({
      kind: 'word',
      senses: [{ translation: 'ספר', part_of_speech: 'noun' }],
    });
  });

  it('keeps two namespaces from seeing each other', async () => {
    const a = ns('iso-a');
    const b = ns('iso-b');
    await expectGeminiJson(a, { kind: 'word', senses: [{ translation: 'א' }] });
    await expectGeminiStatus(b, 500);

    const resA = await fetch(`${geminiBaseUrlFor(a)}/v1beta/models/m:generateContent`, {
      method: 'POST',
      body: '{}',
    });
    const resB = await fetch(`${geminiBaseUrlFor(b)}/v1beta/models/m:generateContent`, {
      method: 'POST',
      body: '{}',
    });

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(500);
  });

  it('verifies which headers a request carried', async () => {
    const namespace = ns('verify');
    await expectGeminiJson(namespace, { kind: 'word', senses: [] });

    await fetch(`${geminiBaseUrlFor(namespace)}/v1beta/models/m:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': 'secret-value' },
      body: '{}',
    });

    await expect(verifyGeminiHeader(namespace, 'x-goog-api-key', 'secret-value')).resolves.toBe(
      true,
    );
    await expect(verifyGeminiHeader(namespace, 'x-goog-api-key', 'wrong')).resolves.toBe(false);
  });
});
