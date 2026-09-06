import { describe, expect, it } from '@jest/globals';

import { createApp } from './app';
import { createFakeAppDeps } from '../tests/support/fakes';

// The "documentation cannot drift" proof, and a unit test: after phase 5
// createApp accepts fakes, so generating the document needs no database.
async function openApiDocument() {
  const res = await createApp(createFakeAppDeps()).request('/openapi.json');
  expect(res.status).toBe(200);
  return await res.json();
}

describe('POST /api/sessions in the published document', () => {
  it('is declared', async () => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths)).toContain('/api/sessions');
    expect(doc.paths['/api/sessions'].post).toBeDefined();
  });

  it('declares its 200 and its 400', async () => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths['/api/sessions'].post.responses).sort()).toEqual(['200', '400']);
  });

  it('declares a JSON request body', async () => {
    const doc = await openApiDocument();
    const body = doc.paths['/api/sessions'].post.requestBody;
    expect(body.content['application/json'].schema.required).toEqual(['user_id']);
  });

  // The published 400 must describe the body the server actually returns, which
  // the defaultHook keeps as { error: 'invalid request' } — a document that
  // promised a Zod issue payload would be honest about the library and wrong
  // about this server.
  it('declares the error body it actually returns', async () => {
    const doc = await openApiDocument();
    const schema =
      doc.paths['/api/sessions'].post.responses['400'].content['application/json'].schema;
    expect(schema.required).toEqual(['error']);
    expect(schema.properties.error.type).toBe('string');
  });
});
