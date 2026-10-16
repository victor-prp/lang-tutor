import { describe, expect, it } from '@jest/globals';
import type { Target, TargetList } from '@lang-tutor/core/api';

import { createFakeAppDeps, createFakeLogger } from '../../tests/support/fakes';
import { createApp } from '../app';
import {
  AccessDenied,
  EnrollmentNotFound,
  GlossLanguageMismatch,
  InvalidTarget,
  InvalidVocabularyEntry,
  PhotoImportConflict,
  PhotoImportNotFound,
  TargetClosed,
  TargetNotFound,
} from '../errors';
import type { TargetService } from '../services/targets';

// Phase 53 (spec D2, D13). The target routes through createApp, with a fake service: what each
// route asks of it, what it answers for what the service throws, and which bodies never reach
// it. The same routes over the real service and a database are
// tests/integration/routes/targets.test.ts's.

const ACTOR = 'u_1';
const E = 'e_1';
const T = '5f0e4f5e-0000-4000-8000-000000000001';

const TARGET: Target = {
  id: T,
  kind: 'exam',
  due_on: '2030-01-13',
  days_left: 5,
  word_count: 1,
  ready_count: 0,
  readiness_pct: 0,
  today: { state: 'owed', done: 0, planned: 1, extra: 0, next_practice_in: 1 },
  session: null,
  words: [
    {
      gloss_id: 'g1',
      form: 'apple',
      meaning: 'תפוח',
      readiness_pct: 0,
      today: 'owed',
      owed: [],
      starts_in: null,
      skills: [{ dimension: 'written_receptive', value: 0, cap: 3.5 }],
    },
  ],
};
const LIST: TargetList = {
  today: '2030-01-08',
  targets: [
    {
      id: T,
      kind: 'exam',
      due_on: '2030-01-13',
      days_left: 5,
      word_count: 1,
      ready_count: 0,
      readiness_pct: 0,
      today: { state: 'owed', done: 0, planned: 1, extra: 0, next_practice_in: 1 },
      session: { session_id: 's1', status: 'ready', source: 'list', answered: 0, total: 10 },
    },
  ],
};

const ENTRY = { gloss_id: 'g1', variant_id: 'v1' };
const CREATE = { kind: 'exam', due_on: '2030-01-13', photo_import_ids: ['i1'], entries: [ENTRY] };
const ADD = { photo_import_ids: ['i1'], entries: [ENTRY] };
const MOVE = { due_on: '2030-02-01' };

const ROUTES = {
  list: { method: 'GET', path: '/enrollments/' + E + '/targets' },
  create: { method: 'POST', path: '/enrollments/' + E + '/targets', body: CREATE },
  get: { method: 'GET', path: '/targets/' + T },
  move: { method: 'PATCH', path: '/targets/' + T, body: MOVE },
  end: { method: 'POST', path: '/targets/' + T + '/end' },
  add: { method: 'POST', path: '/targets/' + T + '/words', body: ADD },
  remove: { method: 'DELETE', path: '/targets/' + T + '/words/g1' },
} as const;
type RouteName = keyof typeof ROUTES;

type Call = { method: string; args: unknown[] };

/** The app with a fake target service: it records its calls, and answers, or throws `failure`. */
function build({ failure = null, signedIn = true }: { failure?: Error | null; signedIn?: boolean } = {}) {
  const calls: Call[] = [];
  const base = createFakeAppDeps();
  const logger = createFakeLogger();
  const run =
    <T>(method: string, answer: T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      if (failure) throw failure;
      return answer;
    };
  const targets: TargetService = {
    list: run('list', LIST),
    getTarget: run('getTarget', TARGET),
    create: run('create', TARGET),
    addWords: run('addWords', TARGET),
    removeWord: run('removeWord', undefined),
    changeDate: run('changeDate', TARGET),
    end: run('end', undefined),
  };
  const app = createApp({
    ...base,
    logger,
    targets,
    signedIn: { sessionOf: async () => (signedIn ? { userId: ACTOR, email: ACTOR + '@test.invalid' } : null) },
    users: { ...base.users, hasProfile: async () => true },
  });
  return { app, calls, logger };
}

const send = (app: ReturnType<typeof createApp>, route: RouteName) => {
  const spec: { method: string; path: string; body?: unknown } = ROUTES[route];
  return sendTo(app, spec.method, spec.path, spec.body);
};
const sendTo = (app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown) =>
  app.request('/api' + path, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });

describe('the target routes, answering', () => {
  it('lists the active targets of an enrollment, as the signed-in learner', async () => {
    const { app, calls } = build();
    const res = await send(app, 'list');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(LIST);
    expect(calls).toEqual([{ method: 'list', args: [ACTOR, E] }]);
  });

  it('makes a target: 201 with the target, from the body as sent', async () => {
    const { app, calls } = build();
    const res = await send(app, 'create');
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(TARGET);
    expect(calls).toEqual([{ method: 'create', args: [ACTOR, E, CREATE] }]);
  });

  it('reads one target by its id', async () => {
    const { app, calls } = build();
    const res = await send(app, 'get');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(TARGET);
    expect(calls).toEqual([{ method: 'getTarget', args: [ACTOR, T] }]);
  });

  it('moves the date: 200 with the target', async () => {
    const { app, calls } = build();
    const res = await send(app, 'move');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(TARGET);
    expect(calls).toEqual([{ method: 'changeDate', args: [ACTOR, T, MOVE] }]);
  });

  it('adds words: 200 with the target', async () => {
    const { app, calls } = build();
    const res = await send(app, 'add');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(TARGET);
    expect(calls).toEqual([{ method: 'addWords', args: [ACTOR, T, ADD] }]);
  });

  it('ends a target: 204 and no body', async () => {
    const { app, calls } = build();
    const res = await send(app, 'end');
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(calls).toEqual([{ method: 'end', args: [ACTOR, T] }]);
  });

  it('removes a word by its gloss id: 204 and no body', async () => {
    const { app, calls } = build();
    const res = await send(app, 'remove');
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(calls).toEqual([{ method: 'removeWord', args: [ACTOR, T, 'g1'] }]);
  });

  it('takes the learner from the session and from nothing the request says', async () => {
    const { app, calls } = build();
    const res = await app.request('/api/targets/' + T, { headers: { 'x-test-actor': 'u_2', 'x-acting-user-id': 'u_2' } });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ method: 'getTarget', args: [ACTOR, T] }]);
  });
});

type Refusal = { label: string; error: Error; status: number; body: unknown };
const DENIED: Refusal = { label: 'AccessDenied', error: new AccessDenied(ACTOR, E, 'targets.manage'), status: 403, body: { error: 'forbidden' } };
const NO_ENROLLMENT: Refusal = { label: 'EnrollmentNotFound', error: new EnrollmentNotFound(E), status: 404, body: { error: 'enrollment not found' } };
const NO_TARGET: Refusal = { label: 'TargetNotFound', error: new TargetNotFound(T), status: 404, body: { error: 'target not found' } };
const CLOSED: Refusal = { label: 'TargetClosed', error: new TargetClosed(T), status: 409, body: { error: 'target closed' } };
const NOT_READY: Refusal = { label: 'PhotoImportConflict', error: new PhotoImportConflict('i1', 'not ready to save'), status: 409, body: { error: 'photo import not ready' } };
const BAD_DATE: Refusal = { label: 'InvalidTarget due_date', error: new InvalidTarget('due_date'), status: 400, body: { error: 'invalid target', reason: 'due_date' } };
const NO_WORDS: Refusal = { label: 'InvalidTarget no_words', error: new InvalidTarget('no_words'), status: 400, body: { error: 'invalid target', reason: 'no_words' } };
const UNKNOWN_IMPORT: Refusal = {
  label: 'PhotoImportNotFound',
  error: new PhotoImportNotFound('i1'),
  status: 400,
  body: { error: 'invalid target', reason: 'unknown_import' },
};
const BAD_ENTRY: Refusal = { label: 'InvalidVocabularyEntry', error: new InvalidVocabularyEntry('g1'), status: 400, body: { error: 'invalid vocabulary entry' } };
const MISMATCH: Refusal = { label: 'GlossLanguageMismatch', error: new GlossLanguageMismatch('g1'), status: 400, body: { error: 'invalid vocabulary entry' } };

// What each route can be refused with, which is what its 4xx entries in the document say.
const REFUSALS: [RouteName, Refusal[]][] = [
  ['list', [DENIED, NO_ENROLLMENT]],
  ['create', [DENIED, NO_ENROLLMENT, BAD_DATE, NO_WORDS, UNKNOWN_IMPORT, BAD_ENTRY, MISMATCH, NOT_READY]],
  ['get', [DENIED, NO_TARGET]],
  ['move', [DENIED, NO_TARGET, BAD_DATE, CLOSED]],
  ['end', [DENIED, NO_TARGET, CLOSED]],
  ['add', [DENIED, NO_TARGET, CLOSED, UNKNOWN_IMPORT, BAD_ENTRY, MISMATCH, NOT_READY]],
  ['remove', [DENIED, NO_TARGET, CLOSED]],
];

describe('what the target routes answer for what the service refuses', () => {
  const cases = REFUSALS.flatMap(([route, refusals]) =>
    refusals.map((refusal) => [route + ' / ' + refusal.label + ' -> ' + refusal.status, route, refusal] as const),
  );

  it.each(cases)('%s', async (_name, route, refusal) => {
    const { app, calls } = build({ failure: refusal.error });
    const res = await send(app, route);
    expect(res.status).toBe(refusal.status);
    expect(await res.json()).toEqual(refusal.body);
    expect(calls).toHaveLength(1);
  });

  it.each(Object.keys(ROUTES) as RouteName[])('%s: a failure it does not know is a 500, not one of the above', async (route) => {
    const { app, logger } = build({ failure: new Error('connection lost') });
    const res = await send(app, route);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
    expect(logger.errors).toHaveLength(1);
  });
});

// ADR 0003 R7: the validation failure keeps the body the app has always answered, and nothing
// that fails it reaches the service. 2026-02-30 is the one that used to: it has the shape of a day,
// passed the schema, and Postgres refused it (22008) as a 500.
describe('a request that does not validate', () => {
  const entries = (count: number) => Array(count).fill(ENTRY);
  const ids = (count: number) => Array.from({ length: count }, (_, index) => 'i' + index);
  const cases: [string, RouteName, unknown][] = [
    ['create: an unknown kind', 'create', { ...CREATE, kind: 'quiz' }],
    ['create: no kind', 'create', { due_on: CREATE.due_on, photo_import_ids: [], entries: [] }],
    ['create: a date in another format', 'create', { ...CREATE, due_on: '13/01/2030' }],
    ['create: 2026-02-30', 'create', { ...CREATE, due_on: '2026-02-30' }],
    ['create: 2026-13-01', 'create', { ...CREATE, due_on: '2026-13-01' }],
    ['create: 2025-02-29', 'create', { ...CREATE, due_on: '2025-02-29' }],
    ['create: no lists', 'create', { kind: 'exam', due_on: CREATE.due_on }],
    ['create: eleven photos', 'create', { ...CREATE, photo_import_ids: ids(11) }],
    ['create: fifty-one typed words', 'create', { ...CREATE, entries: entries(51) }],
    ['create: a list instead of an object', 'create', []],
    ['create: no body at all', 'create', undefined],
    ['move: no date', 'move', {}],
    ['move: a date in another format', 'move', { due_on: 'soon' }],
    ['move: 2026-02-30', 'move', { due_on: '2026-02-30' }],
    ['move: 2025-02-29', 'move', { due_on: '2025-02-29' }],
    ['move: no body at all', 'move', undefined],
    ['add: nothing to add', 'add', { photo_import_ids: [], entries: [] }],
    ['add: no lists', 'add', {}],
    ['add: eleven photos', 'add', { photo_import_ids: ids(11), entries: [] }],
    ['add: fifty-one typed words', 'add', { photo_import_ids: [], entries: entries(51) }],
    ['add: no body at all', 'add', undefined],
  ];

  it.each(cases)('%s is a 400, and the service is not asked', async (_name, route, body) => {
    const { app, calls } = build();
    const spec = ROUTES[route];
    const res = await sendTo(app, spec.method, spec.path, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
    expect(calls).toEqual([]);
  });

  it('accepts 2024-02-29, a real day, where 2025-02-29 is not', async () => {
    const { app, calls } = build();
    expect((await sendTo(app, 'PATCH', '/targets/' + T, { due_on: '2024-02-29' })).status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});

// Mounted after the session middleware (app.ts): no session is a 401 and no profile a 403, and
// the service is not asked in either case.
describe('the target routes behind the session', () => {
  it.each(Object.keys(ROUTES) as RouteName[])('%s: no session is a 401, and the service is not asked', async (route) => {
    const { app, calls } = build({ signedIn: false });
    const res = await send(app, route);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not signed in' });
    expect(calls).toEqual([]);
  });

  it.each(Object.keys(ROUTES) as RouteName[])('%s: a session without a profile is a 403', async (route) => {
    const base = createFakeAppDeps();
    const calls: Call[] = [];
    const unreachable = async (...args: unknown[]): Promise<never> => {
      calls.push({ method: 'targets', args });
      throw new Error('reached the service');
    };
    const app = createApp({
      ...base,
      targets: { list: unreachable, getTarget: unreachable, create: unreachable, addWords: unreachable, removeWord: unreachable, changeDate: unreachable, end: unreachable },
      signedIn: { sessionOf: async () => ({ userId: ACTOR, email: ACTOR + '@test.invalid' }) },
      users: { ...base.users, hasProfile: async () => false },
    });
    const res = await send(app, route);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'profile required' });
    expect(calls).toEqual([]);
  });
});
