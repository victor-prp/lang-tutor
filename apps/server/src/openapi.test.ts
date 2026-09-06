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

const NEXT_STEP = '/api/sessions/{id}/next-step';

describe(`POST ${NEXT_STEP} in the published document`, () => {
  it('declares every status it can return', async () => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths[NEXT_STEP].post.responses).sort()).toEqual([
      '200',
      '400',
      '404',
      '409',
    ]);
  });

  it('declares the id path parameter', async () => {
    const doc = await openApiDocument();
    expect(doc.paths[NEXT_STEP].post.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ]);
  });

  // The discriminated union the mobile Results screen narrows on, published as
  // a two-member oneOf rather than flattened into a bag of optional fields.
  it('publishes the in-progress/completed union as a two-member oneOf', async () => {
    const doc = await openApiDocument();
    const schema = doc.paths[NEXT_STEP].post.responses['200'].content['application/json'].schema;
    expect(schema.oneOf).toHaveLength(2);
  });

  it('describes each failure with the error body it actually returns', async () => {
    const doc = await openApiDocument();
    for (const status of ['400', '404', '409']) {
      const schema =
        doc.paths[NEXT_STEP].post.responses[status].content['application/json'].schema;
      expect(schema.required).toEqual(['error']);
    }
  });
});

// The load-bearing assertion of the whole phase: this document is generated
// from the route definitions the server actually serves, so it cannot describe
// an endpoint the server does not have, or miss one it does.
describe('the document as a whole', () => {
  it('is an OpenAPI 3.1 document', async () => {
    const doc = await openApiDocument();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toEqual(
      expect.objectContaining({ title: 'lang-tutor API', version: '0.1.0' }),
    );
  });

  it('contains all three paths and nothing else', async () => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/api/sessions',
      NEXT_STEP,
      '/health',
    ]);
  });
});
