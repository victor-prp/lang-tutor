import { describe, expect, it } from '@jest/globals';
import { tmpdir } from 'node:os';

import { createApp } from './app';
import { createFakeAppDeps, createFakeBots, createFakeReminderTick } from '../tests/support/fakes';

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

  // Phase 43 (spec D5): 200 answers the session in stock.
  it('declares its 200, 201, 400, 404 and 409, and the gate\'s 401 and 403', async () => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths['/api/sessions'].post.responses).sort()).toEqual([
      '200',
      '201',
      '400',
      '401',
      '403',
      '404',
      '409',
    ]);
  });

  it('declares a JSON request body', async () => {
    const doc = await openApiDocument();
    const body = doc.paths['/api/sessions'].post.requestBody;
    expect(body.content['application/json'].schema.required).toEqual(['enrollment_id']);
    // Phase 57 (spec D1, D13): the path, optional, so a request that names none is the main path's.
    expect(body.content['application/json'].schema.properties.target_id).toEqual({ type: 'string', minLength: 1 });
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
      '401',
      '403',
      '404',
      '409',
      '422',
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
    for (const status of ['400', '401', '403', '404', '409']) {
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
  it('publishes the same paths when the web export is served (phase 30)', async () => {
    const plain = await (await createApp(createFakeAppDeps()).request('/openapi.json')).json();
    const withWeb = await (
      await createApp({ ...createFakeAppDeps(), webDistDir: tmpdir() }).request('/openapi.json')
    ).json();
    expect(Object.keys(withWeb.paths)).toEqual(Object.keys(plain.paths));
  });

  it('is an OpenAPI 3.1 document', async () => {
    const doc = await openApiDocument();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toEqual(
      expect.objectContaining({ title: 'lang-tutor API', version: '0.1.0' }),
    );
  });

  it('contains all fifty-one paths and nothing else', async () => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/api/auth/email-otp/send-verification-otp',
      '/api/auth/get-session',
      '/api/auth/sign-in/email-otp',
      '/api/auth/sign-out',
      '/api/discovery/runs/{id}',
      '/api/discovery/runs/{id}/cards/{position}/answer',
      '/api/discovery/runs/{id}/end',
      '/api/discovery/runs/{id}/rounds',
      '/api/enrollments',
      '/api/enrollments/{id}/discovery',
      '/api/enrollments/{id}/discovery/profile',
      '/api/enrollments/{id}/discovery/runs',
      '/api/enrollments/{id}/my-words-goal',
      '/api/enrollments/{id}/photo-imports',
      '/api/enrollments/{id}/photo-imports/save',
      '/api/enrollments/{id}/question-type-sessions',
      '/api/enrollments/{id}/sessions/current',
      '/api/enrollments/{id}/targets',
      '/api/enrollments/{id}/vocabulary',
      '/api/enrollments/{id}/vocabulary/glosses/{gloss_id}',
      '/api/enrollments/{id}/vocabulary/question-types',
      '/api/enrollments/{id}/vocabulary/word',
      '/api/grants',
      '/api/grants/{id}',
      '/api/grants/{id}/accept',
      '/api/me',
      '/api/me/new-words',
      '/api/me/push-devices',
      '/api/me/push-devices/unregister',
      '/api/me/reminders',
      '/api/me/reminders/{id}/tap',
      '/api/me/time-zone',
      '/api/photo-imports/{id}',
      '/api/photo-imports/{id}/discard',
      '/api/photo-imports/{id}/items/{position}',
      '/api/photo-imports/{id}/save',
      '/api/sessions',
      '/api/sessions/{id}',
      '/api/sessions/{id}/explain',
      '/api/sessions/{id}/judged-answer',
      NEXT_STEP,
      '/api/sessions/{id}/skip',
      '/api/sessions/{id}/speech',
      '/api/sessions/{id}/start',
      '/api/targets/{id}',
      '/api/targets/{id}/end',
      '/api/targets/{id}/words',
      '/api/targets/{id}/words/{gloss_id}',
      '/api/translations',
      '/api/users',
      '/health',
    ]);
  });
});

// Phase 35 (spec D12). The bot route is published only where it is mounted.
describe('the bot route in the published document', () => {
  const withBots = async () => {
    const res = await createApp({ ...createFakeAppDeps(), bots: createFakeBots() }).request('/openapi.json');
    return await res.json();
  };

  it('is absent where BOT_SECRET is unset', async () => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths).filter((p) => p.startsWith('/api/bots'))).toEqual([]);
    expect(doc.components?.securitySchemes?.botSecret).toBeUndefined();
  });

  it('adds exactly its two paths where it is mounted', async () => {
    const plain = Object.keys((await openApiDocument()).paths);
    const doc = await withBots();
    expect(Object.keys(doc.paths).sort()).toEqual([...plain, '/api/bots/day', '/api/bots/sign-in'].sort());
  });

  it('declares the bearer secret, not the session, and every status each can return', async () => {
    const doc = await withBots();
    expect(doc.components.securitySchemes.botSecret).toMatchObject({ type: 'http', scheme: 'bearer' });
    const signIn = doc.paths['/api/bots/sign-in'].post;
    const day = doc.paths['/api/bots/day'].put;
    expect(signIn.security).toEqual([{ botSecret: [] }]);
    expect(day.security).toEqual([{ botSecret: [] }]);
    expect(Object.keys(signIn.responses).sort()).toEqual(['200', '400', '401', '404']);
    expect(Object.keys(day.responses).sort()).toEqual(['204', '400', '401', '404']);
    expect(signIn.requestBody.content['application/json'].schema.required).toEqual(['name']);
    expect(day.requestBody.content['application/json'].schema.required.sort()).toEqual(['day', 'name']);
  });
});

// Phase 52 (spec D5). The reminder tick is published only where it is mounted, as the bot route is.
describe('the reminder tick in the published document', () => {
  const TICK = '/api/internal/reminders/tick';
  const withTick = async () => {
    const res = await createApp({ ...createFakeAppDeps(), reminderTick: createFakeReminderTick() }).request('/openapi.json');
    return await res.json();
  };

  it('is absent where REMINDER_SECRET is unset', async () => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths).filter((p) => p.startsWith('/api/internal'))).toEqual([]);
    expect(doc.components?.securitySchemes?.reminderSecret).toBeUndefined();
  });

  it('adds exactly its one path where it is mounted', async () => {
    const plain = Object.keys((await openApiDocument()).paths);
    const doc = await withTick();
    expect(Object.keys(doc.paths).sort()).toEqual([...plain, TICK].sort());
  });

  it('declares the bearer secret, not the session, a 202 and a 401, and no body', async () => {
    const doc = await withTick();
    expect(doc.components.securitySchemes.reminderSecret).toMatchObject({ type: 'http', scheme: 'bearer' });
    const tick = doc.paths[TICK].post;
    expect(tick.security).toEqual([{ reminderSecret: [] }]);
    expect(Object.keys(tick.responses).sort()).toEqual(['202', '401']);
    expect(tick.responses['202'].content['application/json'].schema.required).toEqual(['queued']);
    expect(tick.requestBody).toBeUndefined();
  });
});

describe('sign-in in the published document (phase 29)', () => {
  it('publishes the four auth paths, open', async () => {
    const doc = await openApiDocument();
    for (const [path, method] of [
      ['/api/auth/email-otp/send-verification-otp', 'post'],
      ['/api/auth/sign-in/email-otp', 'post'],
      ['/api/auth/get-session', 'get'],
      ['/api/auth/sign-out', 'post'],
    ] as const) {
      expect(doc.paths[path]?.[method]?.security).toEqual([]);
    }
  });

  it('declares the session cookie as the default scheme, and /health as open', async () => {
    const doc = await openApiDocument();
    expect(doc.components.securitySchemes.sessionCookie).toMatchObject({ type: 'apiKey', in: 'cookie' });
    expect(doc.security).toEqual([{ sessionCookie: [] }]);
    expect(doc.paths['/health'].get.security).toEqual([]);
  });

  it('declares 401 on every operation that needs a session, and nothing open but sign-in and /health', async () => {
    const doc = await openApiDocument();
    const open = new Set(['/health', '/api/auth/email-otp/send-verification-otp', '/api/auth/sign-in/email-otp', '/api/auth/get-session', '/api/auth/sign-out']);
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops as Record<string, { responses: Record<string, unknown> }>)) {
        if (open.has(path)) continue;
        expect([`${method} ${path}`, Object.keys(op.responses)]).toEqual([`${method} ${path}`, expect.arrayContaining(['401'])]);
      }
    }
  });

  // Spec D12: the session is the only way to say who you are.
  it('lets no operation name its actor: no header, no user_id in a body, no user id in a path', async () => {
    const doc = await openApiDocument();
    for (const [path, ops] of Object.entries(doc.paths)) {
      expect(path).not.toMatch(/\/users\/\{/);
      for (const op of Object.values(ops as Record<string, { parameters?: { name: string }[]; requestBody?: unknown }>)) {
        expect((op.parameters ?? []).map((p) => p.name.toLowerCase())).not.toContain('x-acting-user-id');
        expect(JSON.stringify(op.requestBody ?? {})).not.toContain('"user_id"');
      }
    }
  });

  it('publishes GET /api/me: signed in is enough, and the profile may be null', async () => {
    const doc = await openApiDocument();
    const op = doc.paths['/api/me'].get;
    expect(Object.keys(op.responses).sort()).toEqual(['200', '401']);
    const schema = op.responses['200'].content['application/json'].schema;
    expect(schema.required.sort()).toEqual(['email', 'user']);
  });

  // Phase 52 (spec D1). The profile carries the zone the server holds, so the app reports its own
  // only when it differs.
  it('publishes the stored time zone on the profile, in GET /api/me and POST /api/users alike', async () => {
    const doc = await openApiDocument();
    const created = doc.paths['/api/users'].post.responses['201'].content['application/json'].schema;
    expect(created.required).toContain('time_zone');
    const me = doc.paths['/api/me'].get.responses['200'].content['application/json'].schema;
    expect(me.properties.user.required).toContain('time_zone');
  });

  it('publishes PUT /api/me/time-zone: a profile is needed, and it answers no body', async () => {
    const doc = await openApiDocument();
    const op = doc.paths['/api/me/time-zone'].put;
    expect(Object.keys(op.responses).sort()).toEqual(['204', '400', '401', '403']);
    expect(op.responses['204'].content).toBeUndefined();
    expect(op.requestBody.required).toBe(true);
  });
});

// Phase 70 (spec D5). The learner's new-word limits, own only like the reminders.
describe('the new-word limits in the published document (phase 70)', () => {
  it.each([
    ['get', ['200', '401', '403']],
    ['put', ['200', '400', '401', '403']],
  ])('declares every status %s /api/me/new-words can return', async (method, statuses) => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths['/api/me/new-words'][method as string].responses).sort()).toEqual(statuses);
  });

  it('publishes the limits in snake_case, per session null for automatic', async () => {
    const doc = await openApiDocument();
    const request = doc.paths['/api/me/new-words'].put.requestBody.content['application/json'].schema;
    expect(request.required.sort()).toEqual(['day_cap', 'discover_count', 'per_session']);
  });
});

// Phase 52 (spec D2, D4, D6, D10). Every reminder endpoint acts on the signed-in user, so each
// needs a profile (403) and a session (401), and none names a user in its path or body.
describe('the reminder endpoints in the published document (phase 52)', () => {
  it.each([
    ['/api/me/reminders', 'get', ['200', '401', '403']],
    ['/api/me/reminders', 'put', ['200', '400', '401', '403']],
    ['/api/me/push-devices', 'put', ['204', '400', '401', '403']],
    ['/api/me/push-devices/unregister', 'post', ['204', '400', '401', '403']],
    ['/api/me/reminders/{id}/tap', 'post', ['204', '401', '403', '404']],
  ])('declares every status %s %s can return', async (path, method, statuses) => {
    const doc = await openApiDocument();
    const operation = doc.paths[path as string][method as string];
    expect(Object.keys(operation.responses).sort()).toEqual(statuses);
  });

  it('publishes the settings in snake_case, with the time zone on the response only', async () => {
    const doc = await openApiDocument();
    const request = doc.paths['/api/me/reminders'].put.requestBody.content['application/json'].schema;
    expect(request.required.sort()).toEqual(['daily_target', 'days', 'enabled', 'times']);
    const response = doc.paths['/api/me/reminders'].get.responses['200'].content['application/json'].schema;
    expect(response.required.sort()).toEqual(['daily_target', 'days', 'enabled', 'time_zone', 'times']);
  });

  it('answers the device and tap calls with no body, and a tap names only the reminder', async () => {
    const doc = await openApiDocument();
    for (const [path, method] of [
      ['/api/me/push-devices', 'put'],
      ['/api/me/push-devices/unregister', 'post'],
      ['/api/me/reminders/{id}/tap', 'post'],
    ]) {
      expect(doc.paths[path][method].responses['204'].content).toBeUndefined();
    }
    expect(doc.paths['/api/me/reminders/{id}/tap'].post.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ]);
  });

  it('describes the 404 and the 400s with the error body the server returns', async () => {
    const doc = await openApiDocument();
    const cases: [string, string, string][] = [
      ['/api/me/reminders/{id}/tap', 'post', '404'],
      ['/api/me/reminders', 'put', '400'],
      ['/api/me/push-devices', 'put', '400'],
      ['/api/me/push-devices/unregister', 'post', '400'],
    ];
    for (const [path, method, status] of cases) {
      const schema = doc.paths[path][method].responses[status].content['application/json'].schema;
      expect(schema.required).toEqual(['error']);
    }
  });
});

describe('the grant endpoints in the published document (phase 28)', () => {
  it.each([
    ['/api/grants', 'post', ['201', '400', '401', '403', '404', '409']],
    ['/api/grants', 'get', ['200', '401', '403']],
    ['/api/grants/{id}/accept', 'post', ['200', '401', '403', '404']],
    ['/api/grants/{id}', 'delete', ['204', '401', '403']],
  ])('declares every status %s %s can return', async (path, method, statuses) => {
    const doc = await openApiDocument();
    const operation = doc.paths[path as string][method as string];
    expect(Object.keys(operation.responses).sort()).toEqual(statuses);
  });
});

describe('the enrollment endpoints in the published document', () => {
  it('declares the photo upload as 202 with 400, 404 and 413', async () => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths['/api/enrollments/{id}/photo-imports'].post.responses).sort()).toEqual(['202', '400', '401', '403', '404', '413']);
    expect(Object.keys(doc.paths['/api/photo-imports/{id}/items/{position}'].patch.responses).sort()).toEqual(['200', '400', '401', '403', '404', '409']);
  });

  it('declares every status POST /api/enrollments can return', async () => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths['/api/enrollments'].post.responses).sort()).toEqual([
      '201',
      '400',
      '401',
      '403',
      '409',
    ]);
  });

  it('declares every status GET /api/enrollments can return', async () => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths['/api/enrollments'].get.responses).sort()).toEqual(['200', '401', '403']);
  });
});

describe('the translation endpoint in the published document', () => {
  it('publishes the translation endpoint with all its statuses', async () => {
    const doc = await openApiDocument();
    const path = doc.paths['/api/translations']?.post;
    expect(path).toBeDefined();
    expect(Object.keys(path.responses).sort()).toEqual(['200', '400', '401', '403', '404', '502']);
  });

  it('says the endpoint learns the enrollment, and uses it only for `saved`', async () => {
    const doc = await openApiDocument();
    expect(doc.paths['/api/translations'].post.description).toMatch(/enrollment_id/);
    expect(doc.paths['/api/translations'].post.description).toMatch(/only/i);
  });

  it('declares the error body it actually returns for a translation failure', async () => {
    const doc = await openApiDocument();
    const responses = doc.paths['/api/translations'].post.responses;
    for (const status of ['400', '404', '502']) {
      const schema = responses[status].content['application/json'].schema;
      expect(schema.properties).toHaveProperty('error');
    }
  });

  it('names every supported pair, Italian included', async () => {
    const doc = await openApiDocument();
    expect(doc.paths['/api/translations'].post.description).toMatch(/Hebrew with Italian/);
    expect(doc.info.description).toMatch(/Italian/);
  });

  // The endpoint costs money on every call and nothing rate-limits it. A reader
  // of the document is the person most likely to point a script at it.
  it('warns in the published description that the endpoint costs money', async () => {
    const doc = await openApiDocument();
    expect(doc.paths['/api/translations'].post.description).toMatch(/rate limit/i);
  });

  // Phase 13 moves the wire for the first time since phase 9, additively. A
  // client that ignores `correction` behaves exactly as it does today, which is
  // what `optional` publishes.
  it('publishes the correction block as an optional property, and loses nothing', async () => {
    const doc = await openApiDocument();
    const schema = doc.paths['/api/translations'].post.responses['200']
      .content['application/json'].schema;

    expect(Object.keys(schema.properties).sort()).toEqual([
      'correction',
      'from',
      'kind',
      'reason',
      'senses',
      'text',
      'to',
    ]);
    expect(schema.required).not.toContain('correction');
    expect(schema.required).not.toContain('reason');
    expect(schema.required.sort()).toEqual(['from', 'kind', 'senses', 'text', 'to']);

    const correction = schema.properties.correction;
    expect(correction.properties).toHaveProperty('corrected_form');
    expect(correction.properties.alternatives.maxItems).toBe(3);
  });
});

describe('the user endpoints in the published document', () => {
  it('publishes /api/users, not /users', async () => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths)).toContain('/api/users');
    expect(Object.keys(doc.paths)).not.toContain('/users');
  });

  // Phase 29 (spec D12): sign-in replaced it.
  it('no longer publishes /api/login', async () => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths)).not.toContain('/api/login');
    expect(Object.keys(doc.paths)).not.toContain('/login');
  });

  it('declares every status POST /api/users can return', async () => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths['/api/users'].post.responses).sort()).toEqual([
      '201',
      '400',
      '401',
      '409',
    ]);
  });

  it('declares the error body the user endpoints actually return', async () => {
    const doc = await openApiDocument();
    const schema =
      doc.paths['/api/users'].post.responses['409'].content['application/json'].schema;
    expect(schema.required).toEqual(['error']);
    expect(schema.properties.error.type).toBe('string');
  });
});

describe('GET /health in the published document', () => {
  it('publishes the identity fields a caller needs to tell two lanes apart', async () => {
    const doc = await openApiDocument();
    const schema = doc.paths['/health'].get.responses['200'].content['application/json'].schema;
    expect(schema.required.sort()).toEqual(['commit', 'database', 'lane', 'ok', 'port', 'version']);
  });
});

describe('the vocabulary endpoints in the published document', () => {
  const BASE = '/api/enrollments/{id}/vocabulary';

  it.each([
    [BASE, 'post', ['200', '400', '401', '403', '404']],
    [BASE, 'get', ['200', '400', '401', '403', '404']],
    [`${BASE}/glosses/{gloss_id}`, 'delete', ['204', '401', '403', '404']],
    [`${BASE}/word`, 'get', ['200', '400', '401', '403', '404']],
  ])('%s %s declares exactly its statuses', async (path, method, statuses) => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths[path][method].responses).sort()).toEqual(statuses);
  });
});

// Phase 53 (spec D2, D13). Seven operations on five paths, each the list owner's alone: so each
// needs a session (401) and a profile (403), and the three that change words or the date, or end a
// target, can find it closed (409).
describe('the target endpoints in the published document (phase 53)', () => {
  const TARGETS = '/api/enrollments/{id}/targets';
  const TARGET = '/api/targets/{id}';
  const END = '/api/targets/{id}/end';
  const WORDS = '/api/targets/{id}/words';
  const WORD = '/api/targets/{id}/words/{gloss_id}';

  it.each([
    [TARGETS, 'get', ['200', '401', '403', '404']],
    [TARGETS, 'post', ['201', '400', '401', '403', '404', '409']],
    [TARGET, 'get', ['200', '401', '403', '404']],
    [TARGET, 'patch', ['200', '400', '401', '403', '404', '409']],
    [END, 'post', ['204', '401', '403', '404', '409']],
    [WORDS, 'post', ['200', '400', '401', '403', '404', '409']],
    [WORD, 'delete', ['204', '401', '403', '404', '409']],
  ])('%s %s declares exactly its statuses', async (path, method, statuses) => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths[path][method].responses).sort()).toEqual(statuses);
  });

  // ADR 0003 R7: the published 400 describes the body the server returns, and an invalid target
  // says why.
  it('publishes the reason of an invalid target on the three 400s that can carry it', async () => {
    const doc = await openApiDocument();
    for (const [path, method] of [
      [TARGETS, 'post'],
      [TARGET, 'patch'],
      [WORDS, 'post'],
    ]) {
      const schema = doc.paths[path][method].responses['400'].content['application/json'].schema;
      expect([path, method, schema.required]).toEqual([path, method, ['error']]);
      expect(schema.properties.error.type).toBe('string');
      expect(schema.properties.reason.enum).toEqual(['due_date', 'no_words', 'unknown_import']);
    }
  });

  it('describes every other failure with the error body the server returns', async () => {
    const doc = await openApiDocument();
    const cases: [string, string, string][] = [
      [TARGETS, 'get', '404'],
      [TARGETS, 'post', '404'],
      [TARGETS, 'post', '409'],
      [TARGET, 'get', '404'],
      [TARGET, 'patch', '404'],
      [TARGET, 'patch', '409'],
      [END, 'post', '404'],
      [END, 'post', '409'],
      [WORDS, 'post', '404'],
      [WORDS, 'post', '409'],
      [WORD, 'delete', '404'],
      [WORD, 'delete', '409'],
    ];
    for (const [path, method, status] of cases) {
      const schema = doc.paths[path][method].responses[status].content['application/json'].schema;
      expect([path, method, status, schema.required]).toEqual([path, method, status, ['error']]);
      expect(schema.properties.error.type).toBe('string');
    }
  });

  it('answers the end of a target and the removal of a word with no body', async () => {
    const doc = await openApiDocument();
    expect(doc.paths[END].post.responses['204'].content).toBeUndefined();
    expect(doc.paths[WORD].delete.responses['204'].content).toBeUndefined();
    expect(doc.paths[END].post.requestBody).toBeUndefined();
    expect(doc.paths[WORD].delete.requestBody).toBeUndefined();
  });

  it('publishes the requests: a create names its kind, date and word lists, the others less', async () => {
    const doc = await openApiDocument();
    const create = doc.paths[TARGETS].post.requestBody;
    expect(create.required).toBe(true);
    expect(create.content['application/json'].schema.required.sort()).toEqual(['due_on', 'entries', 'kind', 'photo_import_ids']);
    expect(create.content['application/json'].schema.properties.kind.enum).toEqual(['homework', 'exam']);
    const date = doc.paths[TARGET].patch.requestBody;
    expect(date.required).toBe(true);
    expect(date.content['application/json'].schema.required).toEqual(['due_on']);
    const add = doc.paths[WORDS].post.requestBody;
    expect(add.required).toBe(true);
    expect(add.content['application/json'].schema.required.sort()).toEqual(['entries', 'photo_import_ids']);
  });

  it('publishes a due date as a string in the form of a learner day, and the word lists with their bounds', async () => {
    const doc = await openApiDocument();
    const create = doc.paths[TARGETS].post.requestBody.content['application/json'].schema;
    expect(create.properties.due_on.type).toBe('string');
    expect(create.properties.due_on.pattern).toBe('^\\d{4}-\\d{2}-\\d{2}$');
    expect(create.properties.photo_import_ids.maxItems).toBe(10);
    expect(create.properties.entries.maxItems).toBe(50);
  });

  it('publishes the list with the learner day, and a target with its words and their readiness', async () => {
    const doc = await openApiDocument();
    const list = doc.paths[TARGETS].get.responses['200'].content['application/json'].schema;
    expect(list.required.sort()).toEqual(['targets', 'today']);
    const SUMMARY = [
      'created_on',
      'days_left',
      'due_on',
      'id',
      'kind',
      'practice_more_little',
      'readiness_pct',
      'readiness_start_pct',
      'ready_count',
      'session',
      'today',
      'word_count',
      'word_readiness',
    ];
    expect(list.properties.targets.items.required.sort()).toEqual(SUMMARY);
    // Phase 71 (spec D3). Each word's readiness, whole percents.
    expect(list.properties.targets.items.properties.word_readiness).toMatchObject({ type: 'array', items: { type: 'integer', minimum: 0, maximum: 100 } });
    const today = list.properties.targets.items.properties.today;
    expect(today.properties.state.enum).toEqual(['owed', 'done', 'rest', 'due_today']);
    // Phase 65 (spec D7, D10). Today as a budget of sessions: null until the day's first session
    // sets it, with the offer shown before.
    expect(today.required.sort()).toEqual(
      ['done', 'ended_early', 'extra', 'minutes', 'next_practice_in', 'planned', 'sessions_budget', 'sessions_done', 'sessions_offer', 'state'],
    );
    expect(today.properties.sessions_budget.type).toEqual(['integer', 'null']);
    expect(today.properties.sessions_offer.type).toBe('integer');
    expect(today.properties.ended_early.type).toBe('boolean');
    expect(list.properties.targets.items.properties.practice_more_little.type).toBe('boolean');
    expect(list.properties.targets.items.properties.readiness_start_pct).toMatchObject({ type: 'integer', minimum: 0, maximum: 100 });
    for (const [path, method, status] of [
      [TARGETS, 'post', '201'],
      [TARGET, 'get', '200'],
      [TARGET, 'patch', '200'],
      [WORDS, 'post', '200'],
    ]) {
      const target = doc.paths[path][method].responses[status].content['application/json'].schema;
      expect(target.required.sort()).toEqual([...SUMMARY, 'words'].sort());
      expect(target.properties.words.items.required.sort()).toEqual(
        ['form', 'gloss_id', 'meaning', 'owed', 'readiness_pct', 'skills', 'starts_in', 'today'],
      );
      expect(target.properties.words.items.properties.today.enum).toEqual(['owed', 'done', 'extra', 'later']);
      expect(target.properties.words.items.properties.readiness).toBeUndefined();
      // Phase 65 (spec D10). A word's counted skills, each a chance in percent and held or not.
      const skill = target.properties.words.items.properties.skills.items;
      expect(skill.required.sort()).toEqual(['chance', 'dimension', 'held']);
      expect(skill.properties.chance).toMatchObject({ type: 'integer', minimum: 0, maximum: 100 });
      expect(skill.properties.held.type).toBe('boolean');
    }
  });

  it('names the path parameters', async () => {
    const doc = await openApiDocument();
    expect(doc.paths[WORD].delete.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'gloss_id', in: 'path', required: true, schema: { type: 'string' } },
    ]);
    expect(doc.paths[TARGET].get.parameters).toEqual([{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]);
  });

  it('is open to no one without a session: each operation carries the session scheme and a 401', async () => {
    const doc = await openApiDocument();
    for (const [path, method] of [
      [TARGETS, 'get'],
      [TARGETS, 'post'],
      [TARGET, 'get'],
      [TARGET, 'patch'],
      [END, 'post'],
      [WORDS, 'post'],
      [WORD, 'delete'],
    ]) {
      expect(doc.paths[path][method].security).toBeUndefined();
      expect(doc.paths[path][method].responses['401']).toBeDefined();
    }
    expect(doc.security).toEqual([{ sessionCookie: [] }]);
  });
});

describe('phase 19 paths in the published document', () => {
  it('publishes read, skip and current', async () => {
    const doc = await openApiDocument();
    expect(doc.paths['/api/sessions/{id}'].get).toBeDefined();
    expect(Object.keys(doc.paths['/api/sessions/{id}/skip'].post.responses).sort()).toEqual(['200', '401', '403', '404', '409']);
    expect(Object.keys(doc.paths['/api/enrollments/{id}/sessions/current'].get.responses).sort()).toEqual(['200', '400', '401', '403', '404']);
    expect(Object.keys(doc.paths[NEXT_STEP].post.responses)).toContain('409');
  });
});

// Phase 57 (spec D1, D11, D13).
describe('GET /api/enrollments/{id}/sessions/current in the published document', () => {
  it("takes the path as an optional target_id, and answers the path's words waiting", async () => {
    const doc = await openApiDocument();
    const op = doc.paths['/api/enrollments/{id}/sessions/current'].get;
    expect(op.parameters).toContainEqual(expect.objectContaining({ in: 'query', name: 'target_id', required: false }));
    const schema = op.responses['200'].content['application/json'].schema;
    expect(schema.required).toContain('due_count');
    expect(schema.properties.due_count.type).toBe('integer');
  });
});

describe('POST /api/sessions/{id}/speech in the published document', () => {
  it('declares every status it can return, and says it costs money', async () => {
    const doc = await openApiDocument();
    const op = doc.paths['/api/sessions/{id}/speech'].post;
    expect(Object.keys(op.responses).sort()).toEqual(['200', '400', '401', '403', '404', '409', '413', '502']);
    expect(op.description).toMatch(/costs money/);
  });
});

describe('POST /api/sessions/{id}/judged-answer in the published document', () => {
  it('declares every status it can return, and says it costs money', async () => {
    const doc = await openApiDocument();
    const op = doc.paths['/api/sessions/{id}/judged-answer'].post;
    expect(Object.keys(op.responses).sort()).toEqual(['200', '400', '401', '403', '404', '409', '422', '502']);
    expect(op.description).toMatch(/costs money/);
  });
});

// Phase 29 (spec D13). Every route whose refusal has a rule of its own says it
// in its 403, and still says the gate's own 403 (a session without a profile).
describe('the 403 of an owner-only or granted route in the published document', () => {
  const VOCABULARY = '/api/enrollments/{id}/vocabulary';
  // Phase 53 (spec D2): a target is its list owner's alone, a tutor of the list included.
  const OWNER_ONLY = /owner, who alone may read or change a target, a tutor of the list included/;
  it.each([
    [VOCABULARY, 'post', /accepted grant that allows adding words/],
    [VOCABULARY, 'get', /owner, who alone may read it/],
    [`${VOCABULARY}/glosses/{gloss_id}`, 'delete', /owner, who alone may remove a word/],
    [`${VOCABULARY}/word`, 'get', /owner, who alone may read it/],
    // Phase 61 (spec D1).
    [`${VOCABULARY}/question-types`, 'get', /not a tester/],
    ['/api/enrollments/{id}/question-type-sessions', 'post', /not a tester/],
    ['/api/sessions', 'post', /another learner's/],
    ['/api/sessions/{id}', 'get', /another learner's/],
    ['/api/sessions/{id}/skip', 'post', /another learner's/],
    ['/api/sessions/{id}/next-step', 'post', /another learner's/],
    ['/api/sessions/{id}/speech', 'post', /another learner's/],
    ['/api/sessions/{id}/judged-answer', 'post', /another learner's/],
    ['/api/enrollments/{id}/sessions/current', 'get', /another learner's/],
    ['/api/enrollments/{id}/photo-imports', 'post', /another learner's/],
    ['/api/enrollments/{id}/photo-imports', 'get', /another learner's/],
    ['/api/photo-imports/{id}', 'get', /another learner's/],
    ['/api/photo-imports/{id}/items/{position}', 'patch', /another learner's/],
    ['/api/photo-imports/{id}/save', 'post', /another learner's/],
    ['/api/photo-imports/{id}/discard', 'post', /another learner's/],
    // Phase 69 (spec D10).
    ['/api/enrollments/{id}/discovery', 'get', /another learner's/],
    ['/api/enrollments/{id}/discovery/profile', 'post', /another learner's/],
    ['/api/enrollments/{id}/discovery/runs', 'post', /another learner's/],
    ['/api/discovery/runs/{id}', 'get', /another learner's/],
    ['/api/discovery/runs/{id}/rounds', 'post', /another learner's/],
    ['/api/discovery/runs/{id}/cards/{position}/answer', 'post', /another learner's/],
    ['/api/discovery/runs/{id}/end', 'post', /another learner's/],
    // Phase 73 (spec D1).
    ['/api/enrollments/{id}/my-words-goal', 'get', /another learner's/],
    ['/api/enrollments/{id}/my-words-goal', 'put', /another learner's/],
    ['/api/enrollments/{id}/targets', 'get', OWNER_ONLY],
    ['/api/enrollments/{id}/targets', 'post', OWNER_ONLY],
    ['/api/targets/{id}', 'get', OWNER_ONLY],
    ['/api/targets/{id}', 'patch', OWNER_ONLY],
    ['/api/targets/{id}/end', 'post', OWNER_ONLY],
    ['/api/targets/{id}/words', 'post', OWNER_ONLY],
    ['/api/targets/{id}/words/{gloss_id}', 'delete', OWNER_ONLY],
    ['/api/translations', 'post', /another learner's enrollment/],
    ['/api/grants/{id}/accept', 'post', /owner, who alone may accept or decline an invite/],
    ['/api/grants/{id}', 'delete', /neither party to this grant/],
  ])('%s %s names its rule and the missing profile', async (path, method, rule) => {
    const doc = await openApiDocument();
    const { description } = doc.paths[path][method].responses['403'];
    expect(description).toMatch(rule);
    expect(description).toMatch(/without a profile/);
  });
});
