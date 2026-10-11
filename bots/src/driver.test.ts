import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runDays, dateOf } from './driver.ts';
import { FakeServer } from './fakeServer.ts';
import { ROSTER, type Profile } from './roster.ts';
import { memoryStore } from './state.ts';

/** A bot whose day is fixed: plays, saves two words, one session. */
function bot(name: string, overrides: Partial<Profile> = {}): Profile {
  return {
    ...ROSTER[0],
    name,
    sessions: [1, 1],
    lookups: [2, 2],
    burstChance: 0,
    playChance: 1,
    devices: { listening: false, speaking: false },
    ...overrides,
  };
}

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];

function options(server: FakeServer, store = memoryStore(), profiles = [bot('steady-en')]) {
  return {
    profiles,
    days: 1,
    route: server.route,
    apiFor: (cookie: string) => server.apiFor(cookie),
    store,
    wordsFor: () => WORDS,
    synthesize: async () => null,
    log: () => {},
    poll: { intervalMs: 0, timeoutMs: 1_000 },
  };
}

test('one day of play makes the expected calls', async () => {
  const server = new FakeServer();
  const store = memoryStore();
  await runDays(options(server, store));

  assert.deepEqual(server.calls, [
    'steady-en sign-in',
    `steady-en day ${dateOf(1)}`,
    'steady-en enrollments',
    'steady-en enroll en',
    'steady-en translate alpha',
    'steady-en save',
    'steady-en translate beta',
    'steady-en save',
    // The lemma of each new word, which cards show when the saved form is inflected.
    'steady-en vocabulary',
    // The enrollment's first session is the seed, skipped unplayed; the list session follows.
    'steady-en create-session',
    'steady-en skip',
    'steady-en create-session',
    'steady-en get-session',
    'steady-en get-session',
    'steady-en next-step',
    'steady-en next-step',
    'steady-en sign-out',
  ]);
  assert.deepEqual(server.bodies.find((b) => b.call === 'steady-en create-session')?.body, { listening: false, speaking: false });

  const state = await store.load('steady-en');
  assert.equal(state.day, 1);
  assert.equal(state.position, 2);
  assert.deepEqual(
    state.saved.map((w) => [w.form, w.lemma, w.key]),
    [
      ['alpha', 'alpha', 'משמעות-alpha'],
      ['beta', 'beta', 'משמעות-beta'],
    ],
  );
  assert.equal(state.log.length, 2);
  assert.deepEqual(state.days.at(-1), {
    day: 1,
    date: dateOf(1),
    played: true,
    completed: true,
    sessions: 1,
    cards: 2,
    right: state.log.filter((c) => c.correct).length,
    newWords: 2,
    unheard: 0,
    noVoice: 0,
    unmatched: 0,
    failed: 0,
    // At the session's start, two saved words in three live dimensions, none recalled yet.
    listPairs: 6,
    listWeak: 6,
  });
});

test('a failed request ends that bot\'s day and the run goes on', async () => {
  const server = new FakeServer({ failOn: (call) => call === 'steady-en save' });
  const store = memoryStore();
  await runDays(options(server, store, [bot('steady-en'), bot('other-en')]));

  const steady = server.calls.filter((c) => c.startsWith('steady-en '));
  assert.deepEqual(steady, [
    'steady-en sign-in',
    `steady-en day ${dateOf(1)}`,
    'steady-en enrollments',
    'steady-en enroll en',
    'steady-en translate alpha',
    'steady-en save',
    'steady-en sign-out',
  ]);
  assert.ok(server.calls.includes('other-en next-step'), 'the next bot plays its day');

  const failed = await store.load('steady-en');
  assert.equal(failed.day, 0, 'a failed day is not counted');
  assert.equal(failed.days.at(-1)?.failed, 1);
  assert.equal(failed.days.at(-1)?.completed, false);
  assert.equal((await store.load('other-en')).day, 1);
});

test('a run that dies after bot 2 leaves the rest on the old day, and the next run repeats it for them only', async () => {
  const store = memoryStore();
  const profiles = [bot('one-en'), bot('two-en'), bot('three-en'), bot('four-en')];
  const dying = new FakeServer({ crashOn: (call) => call === 'three-en sign-in' });
  await assert.rejects(runDays(options(dying, store, profiles)), /crash on three-en sign-in/);

  assert.deepEqual(
    await Promise.all(profiles.map(async (p) => (await store.load(p.name)).day)),
    [1, 1, 0, 0],
  );

  const next = new FakeServer();
  // The next run starts from the store: bots one and two already have day 1.
  await runDays(options(next, store, profiles));
  assert.deepEqual(
    next.calls.filter((c) => c.endsWith('sign-in')),
    ['three-en sign-in', 'four-en sign-in'],
  );
  assert.ok(next.calls.includes(`three-en day ${dateOf(1)}`));
  assert.deepEqual(
    await Promise.all(profiles.map(async (p) => (await store.load(p.name)).day)),
    [1, 1, 1, 1],
  );
});

test('days run one after another, every bot on the same day', async () => {
  const server = new FakeServer();
  const store = memoryStore();
  await runDays({ ...options(server, store, [bot('one-en'), bot('two-en')]), days: 2 });
  assert.deepEqual(
    server.calls.filter((c) => c.includes(' day ')),
    [`one-en day ${dateOf(1)}`, `two-en day ${dateOf(1)}`, `one-en day ${dateOf(2)}`, `two-en day ${dateOf(2)}`],
  );
});

test('a day that keeps failing is given up after three attempts, so one bot cannot hold the others back', async () => {
  const server = new FakeServer({ failOn: (call) => call === 'one-en save' });
  const store = memoryStore();
  await runDays({ ...options(server, store, [bot('one-en')]), days: 3 });
  const state = await store.load('one-en');
  assert.equal(state.day, 1);
  assert.deepEqual(
    state.days.map((d) => [d.day, d.completed, d.failed]),
    [
      [1, false, 1],
      [1, false, 1],
      [1, false, 1],
    ],
  );
});

test('day 1 is the epoch, and every later day the next date', () => {
  assert.equal(dateOf(1), '2026-01-01');
  assert.equal(dateOf(32), '2026-02-01');
});
