import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { dateOf, runDays } from './driver.ts';
import { FakeServer } from './fakeServer.ts';
import type { IssueRef, IssueSink } from './issue.ts';
import { createReporter } from './report.ts';
import { ROSTER, type Profile } from './roster.ts';
import { memoryStore, type StateStore } from './state.ts';
import { weeklyIssue } from './week.ts';

/**
 * The weekly issue over whole runs of the driver, against the in-memory server. Nothing here
 * reaches gh, claude, git or the network: the sink records, the reporter's runner is a fake.
 */
const SAMPLE = readFileSync(new URL('../fixtures/claude-result.json', import.meta.url), 'utf8');

function bot(name: string): Profile {
  return {
    ...ROSTER[0],
    name,
    sessions: [1, 1],
    lookups: [2, 2],
    burstChance: 0,
    playChance: 1,
    devices: { listening: false, speaking: false },
  };
}

/** Records what would be filed; files nothing. `fail` makes a matching event throw instead. */
function recordingSink() {
  const events: string[] = [];
  const bodies: string[] = [];
  const closed = new Set<number>();
  const control = { fail: (_event: string) => false };
  const record = (event: string) => {
    if (control.fail(event)) throw new Error(`gh failed on ${event}`);
    events.push(event);
  };
  const sink: IssueSink = {
    async open(week) {
      record(`open ${week}`);
      return { week, number: week, closed: closed.has(week) };
    },
    async comment(ref: IssueRef, body: string) {
      record(`comment ${ref.week}: ${body.split('\n')[0]}`);
      bodies.push(body);
    },
    async close(ref: IssueRef) {
      record(`close ${ref.week}`);
      closed.add(ref.week);
    },
    where: (ref) => `#${ref.number}`,
  };
  return { sink, events, bodies, control };
}

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega', 'one', 'two', 'three', 'four', 'five', 'six'];

function setup(store: StateStore = memoryStore()) {
  const claude: string[][] = [];
  const recorded = recordingSink();
  const profiles = [bot('one-en'), bot('two-en')];
  /** One run of the driver: a new process, so a new report limit. `weekly: false` plays without the issue. */
  const run = (server: FakeServer, days: number, opts: { limit?: number; weekly?: boolean } = {}) => {
    const reporter = createReporter({
      run: async (args) => {
        claude.push([...args]);
        return SAMPLE;
      },
      runId: '777',
      limit: opts.limit,
    });
    return runDays({
      profiles,
      days,
      route: server.route,
      apiFor: (cookie) => server.apiFor(cookie),
      store,
      wordsFor: () => WORDS,
      synthesize: async () => null,
      log: () => {},
      poll: { intervalMs: 0, timeoutMs: 1_000 },
      ...(opts.weekly === false ? {} : weeklyIssue({ profiles, store, sink: recorded.sink, reporter, log: () => {} })),
    });
  };
  return { run, store, claude, profiles, ...recorded };
}

test('the week\'s last day closes it: a report per bot, the closing comment, and the issue closed', async () => {
  const { run, store, claude, events } = setup();
  await run(new FakeServer(), 6);
  assert.equal(claude.length, 0, 'no report before the week ends');
  assert.deepEqual(events.slice(0, 2), ['open 1', `comment 1: **Day 1** (${dateOf(1)})`]);
  assert.equal(events.filter((e) => e.startsWith('comment 1: **Day')).length, 6);

  await run(new FakeServer(), 1);
  assert.equal(claude.length, 2, 'one report per bot');
  assert.deepEqual(events.slice(-5), ['open 1', `comment 1: **Day 7** (${dateOf(7)})`, 'open 1', 'comment 1: ## Week 1 closed', 'close 1']);

  const one = await store.load('one-en');
  assert.deepEqual(one.weeks?.map((w) => w.week), [1]);
  assert.ok((one.weeks?.[0].cards ?? 0) > 0);
  assert.equal(one.weeks?.[0].late, undefined);
  assert.equal(typeof one.weeks?.[0].e, 'number');
  assert.deepEqual(
    one.reports?.map((r) => [r.bot, r.week, r.runId, r.costUsd]),
    [['one-en', 1, '777', 0.073523]],
  );

  // Day 8 finds week 1 closed and reports nothing; its day goes to week 2.
  await run(new FakeServer(), 1);
  assert.equal(claude.length, 2);
  assert.deepEqual(events.slice(-3), ['open 1', 'open 2', `comment 2: **Day 8** (${dateOf(8)})`]);
});

test('a week whose last day failed for one bot closes when that bot finishes it', async () => {
  const { run, claude, events } = setup();
  await run(new FakeServer(), 6);
  await run(new FakeServer({ failOn: (call) => call === `two-en day ${dateOf(7)}` }), 1);
  assert.equal(claude.length, 0);
  assert.ok(!events.includes('close 1'));

  // The next run plays day 7 again, for two-en only, and closes the week.
  await run(new FakeServer(), 1);
  assert.equal(claude.length, 2);
  assert.deepEqual(events.slice(-4), [`comment 1: **Day 7** (${dateOf(7)})`, 'open 1', 'comment 1: ## Week 1 closed', 'close 1']);
});

test('a close that fails on the week\'s last run is finished by the next run, before it plays a day', async () => {
  const { run, store, claude, events, bodies, control } = setup();
  await run(new FakeServer(), 6);
  control.fail = (event) => event === 'comment 1: ## Week 1 closed';
  await assert.rejects(run(new FakeServer(), 1), /gh failed on comment 1: ## Week 1 closed/);
  assert.equal(claude.length, 2, 'the reports were made, and kept');
  assert.ok(!events.includes('close 1'));

  control.fail = () => false;
  const before = events.length;
  await run(new FakeServer(), 1);
  // Closed first, then day 8 is played and goes to week 2.
  assert.deepEqual(events.slice(before), ['open 1', 'comment 1: ## Week 1 closed', 'close 1', 'open 2', `comment 2: **Day 8** (${dateOf(8)})`]);
  assert.equal(claude.length, 2, 'never paid twice');
  assert.match(bodies.at(-2) ?? '', /Closed by a later run/);
  // Closed before day 8 was played: the memory was still the week's end, so (e) is exact.
  const one = await store.load('one-en');
  assert.equal(typeof one.weeks?.[0].e, 'number');
  assert.equal(one.weeks?.[0].late, undefined);
});

test('a tracker that fails before a day does not stop the day; the run goes red at its end', async () => {
  const { run, store, events, control } = setup();
  await run(new FakeServer(), 6);
  // Day 7's close fails on its closing comment, so the next run's beforeDay closes week 1.
  control.fail = (event) => event === 'comment 1: ## Week 1 closed';
  await assert.rejects(run(new FakeServer(), 1), /gh failed on comment 1: ## Week 1 closed/);

  // The tracker fails once, on beforeDay's first look at week 1; afterDay's close works.
  let opens = 0;
  control.fail = (event) => event === 'open 1' && ++opens === 1;
  const server = new FakeServer();
  await assert.rejects(run(server, 1), /closing a finished week failed 1 time\(s\): before day 8: gh failed on open 1/);
  // Day 8 was played regardless; after it, week 1 closed (late) and day 8 went to week 2.
  assert.ok(server.calls.includes(`one-en day ${dateOf(8)}`));
  assert.equal((await store.load('one-en')).day, 8);
  assert.equal((await store.load('two-en')).day, 8);
  assert.deepEqual(events.slice(-5), ['open 2', `comment 2: **Day 8** (${dateOf(8)})`, 'open 1', 'comment 1: ## Week 1 closed', 'close 1']);

  // A tracker that stays down: the day is still played, and the run is still red.
  control.fail = (event) => event.startsWith('open');
  const down = new FakeServer();
  await assert.rejects(run(down, 1), /gh failed on open/);
  assert.equal((await store.load('one-en')).day, 9);
});

test('an error that is not the tracker\'s still stops the run before the day', async () => {
  const { run, store } = setup();
  await run(new FakeServer(), 7, { weekly: false });
  const failing: StateStore = { load: (name) => store.load(name), save: async () => { throw new Error('push rejected'); } };
  const { run: runFailing } = setup(failing);
  const server = new FakeServer();
  await assert.rejects(runFailing(server, 1), /push rejected/);
  assert.ok(!server.calls.some((c) => c.includes(' day ')), 'no day was played');
});

test('a failed daily comment does not keep the week from closing, and still fails the run', async () => {
  const { run, events, control } = setup();
  await run(new FakeServer(), 6);
  control.fail = (event) => event.startsWith('comment 1: **Day 7**');
  await assert.rejects(run(new FakeServer(), 1), /gh failed on comment 1: \*\*Day 7\*\*/);
  assert.deepEqual(events.slice(-3), ['open 1', 'comment 1: ## Week 1 closed', 'close 1']);
});

test('weeks missed for days are closed late without (e), and the report limit spreads the calls over runs', async () => {
  const { run, store, claude, events } = setup();
  // Two weeks played with no issue at all: as if every close had failed.
  await run(new FakeServer(), 14, { weekly: false });
  assert.equal(events.length, 0);

  // Three report calls a run: week 1 takes two, week 2 gets one and waits. Day 15 is played.
  await run(new FakeServer(), 1, { limit: 3 });
  assert.equal(claude.length, 3);
  assert.deepEqual(events.slice(0, 4), ['open 1', 'comment 1: ## Week 1 closed', 'close 1', 'open 2']);
  assert.ok(!events.includes('close 2'));
  assert.ok(events.includes(`comment 3: **Day 15** (${dateOf(15)})`));

  // Week 1 was closed with day 14's memory: (e) left out. Week 2's numbers were made before
  // day 15 was played, while the memory was still its end, so its (e) is exact.
  const one = await store.load('one-en');
  assert.deepEqual(one.weeks?.map((w) => [w.week, w.late ?? false, w.e === null]), [[1, true, true], [2, false, false]]);

  // The next run finishes week 2 with the one report left, before playing day 16.
  const before = events.length;
  await run(new FakeServer(), 1, { limit: 3 });
  assert.equal(claude.length, 4);
  assert.deepEqual(events.slice(before, before + 3), ['open 2', 'comment 2: ## Week 2 closed', 'close 2']);
});

test('a closed week is not closed or reported again', async () => {
  const store = memoryStore();
  const { run, claude, profiles } = setup(store);
  await run(new FakeServer(), 7);
  assert.equal(claude.length, 2);

  // The hooks again around day 7's end, as a rerun would call them: the issue is closed.
  const { sink, events } = recordingSink();
  await sink.close({ week: 1, number: 1, closed: false });
  const reporter = createReporter({ run: async () => assert.fail('no call'), runId: 'x' });
  const states = new Map(await Promise.all(profiles.map(async (p) => [p.name, await store.load(p.name)] as const)));
  const weekly = weeklyIssue({ profiles, store, sink, reporter, log: () => {} });
  await weekly.afterDay({ day: 7, states, played: [] });
  await weekly.beforeDay({ day: 8, states });
  // One lookup finds it closed; the run does not look again.
  assert.deepEqual(events, ['close 1', 'open 1']);
});
