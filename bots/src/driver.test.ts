import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runDays, dateOf } from './driver.ts';
import { FakeServer } from './fakeServer.ts';
import { ROSTER, type Profile } from './roster.ts';
import { memoryStore, type BotState, type StateStore } from './state.ts';

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

/** A memory store that also keeps a copy of every save, with its message. */
function recordingStore(): StateStore & { saves: { message: string; state: BotState }[] } {
  const inner = memoryStore();
  const saves: { message: string; state: BotState }[] = [];
  return {
    saves,
    load: (name) => inner.load(name),
    save: async (state, message) => {
      saves.push({ message, state: JSON.parse(JSON.stringify(state)) as BotState });
      await inner.save(state, message);
    },
  };
}

test('a crash in session 2 of 2 keeps session 1, and the next run plays only what is left', async () => {
  const store = recordingStore();
  const profiles = [bot('steady-en', { sessions: [2, 2] })];
  // create-session runs three times: the seed, session 1, then session 2, which crashes.
  let creates = 0;
  const server = new FakeServer({ crashOn: (call) => call === 'steady-en create-session' && ++creates === 3 });
  await assert.rejects(runDays(options(server, store, profiles)), /crash on steady-en create-session/);

  // Saved after the words, after session 1, and once more in the crash's finally.
  assert.deepEqual(store.saves.map((s) => s.message), [
    'steady-en: day 1, words saved',
    'steady-en: day 1, session 1 of 2',
    'steady-en: day 1, crashed',
  ]);
  // A run killed outright stops at the session-1 checkpoint: it already holds session 1.
  const killed = store.saves[1].state;
  assert.equal(killed.log.length, 2);
  assert.deepEqual(killed.progress, { day: 1, lookups: 2, sessions: 1 });

  const crashed = await store.load('steady-en');
  assert.equal(crashed.day, 0, 'the day is not finished');
  assert.equal(crashed.attempts, 1);
  assert.deepEqual(crashed.progress, { day: 1, lookups: 2, sessions: 1 });
  assert.deepEqual(crashed.saved.map((w) => w.form), ['alpha', 'beta'], 'words saved in the crashed attempt');
  assert.equal(crashed.log.length, 2, 'session 1 is in the log');
  assert.ok(Object.keys((crashed.memory as { traces: object }).traces).length > 0, 'and in the traces');
  assert.deepEqual(crashed.days.map((d) => [d.day, d.completed, d.sessions, d.newWords]), [[1, false, 1, 2]]);

  // The next run, on the same server: no lookups, one session, then the day is done.
  const before = server.calls.length;
  creates = 99;
  await runDays(options(server, store, profiles));
  const next = server.calls.slice(before);
  assert.ok(!next.some((c) => c.includes('translate') || c.endsWith(' save')), next.join('\n'));
  assert.equal(next.filter((c) => c.endsWith('create-session')).length, 1);
  const done = await store.load('steady-en');
  assert.equal(done.day, 1);
  assert.equal(done.attempts, 0);
  assert.equal(done.progress, undefined);
  assert.equal(done.position, 2);
  assert.equal(done.log.length, 4);
  assert.deepEqual(done.days.map((d) => [d.day, d.completed, d.sessions, d.newWords]), [
    [1, false, 1, 2],
    [1, true, 1, 0],
  ]);
});

test('a failed request in session 2 is retried from session 2, not from the start', async () => {
  const store = memoryStore();
  const profiles = [bot('steady-en', { sessions: [2, 2] })];
  let creates = 0;
  const server = new FakeServer({ failOn: (call) => call === 'steady-en create-session' && ++creates === 3 });
  await runDays(options(server, store, profiles));
  const failed = await store.load('steady-en');
  assert.equal(failed.day, 0);
  assert.deepEqual(failed.progress, { day: 1, lookups: 2, sessions: 1 });

  const before = server.calls.length;
  await runDays(options(server, store, profiles));
  const next = server.calls.slice(before);
  assert.ok(!next.some((c) => c.includes('translate')));
  assert.equal(next.filter((c) => c.endsWith('create-session')).length, 1);
  assert.equal((await store.load('steady-en')).day, 1);
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
