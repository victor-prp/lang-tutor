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

/** Records what would be filed; files nothing. */
function recordingSink() {
  const events: string[] = [];
  const closed = new Set<number>();
  const sink: IssueSink = {
    async open(week) {
      events.push(`open ${week}`);
      return { week, number: week, closed: closed.has(week) };
    },
    async comment(ref: IssueRef, body: string) {
      events.push(`comment ${ref.week}: ${body.split('\n')[0]}`);
    },
    async close(ref: IssueRef) {
      closed.add(ref.week);
      events.push(`close ${ref.week}`);
    },
    where: (ref) => `#${ref.number}`,
  };
  return { sink, events };
}

function setup(store: StateStore = memoryStore()) {
  const claude: string[][] = [];
  const reporter = createReporter({
    run: async (args) => {
      claude.push([...args]);
      return SAMPLE;
    },
    runId: '777',
  });
  const { sink, events } = recordingSink();
  const profiles = [bot('one-en'), bot('two-en')];
  const run = (server: FakeServer, days: number) =>
    runDays({
      profiles,
      days,
      route: server.route,
      apiFor: (cookie) => server.apiFor(cookie),
      store,
      wordsFor: () => ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron'],
      synthesize: async () => null,
      log: () => {},
      poll: { intervalMs: 0, timeoutMs: 1_000 },
      afterDay: weeklyIssue({ profiles, store, sink, reporter, log: () => {} }),
    });
  return { run, store, claude, events };
}

test('the week\'s last day closes it: a report per bot, the closing comment, and the issue closed', async () => {
  const { run, store, claude, events } = setup();
  await run(new FakeServer(), 6);
  assert.equal(claude.length, 0, 'no report before the week ends');
  assert.deepEqual(events.slice(0, 2), ['open 1', `comment 1: **Day 1** (${dateOf(1)})`]);
  assert.equal(events.filter((e) => e.startsWith('comment 1: **Day')).length, 6);

  await run(new FakeServer(), 1);
  assert.equal(claude.length, 2, 'one report per bot');
  assert.deepEqual(events.slice(-4), ['open 1', `comment 1: **Day 7** (${dateOf(7)})`, 'comment 1: ## Week 1 closed', 'close 1']);

  const one = await store.load('one-en');
  assert.deepEqual(one.weeks?.map((w) => w.week), [1]);
  assert.ok((one.weeks?.[0].cards ?? 0) > 0);
  assert.deepEqual(
    one.reports?.map((r) => [r.bot, r.week, r.runId, r.costUsd]),
    [['one-en', 1, '777', 0.073523]],
  );

  // Day 8 opens week 2 and reports nothing.
  await run(new FakeServer(), 1);
  assert.equal(claude.length, 2);
  assert.deepEqual(events.slice(-2), ['open 2', `comment 2: **Day 8** (${dateOf(8)})`]);
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
  assert.deepEqual(events.slice(-3), [`comment 1: **Day 7** (${dateOf(7)})`, 'comment 1: ## Week 1 closed', 'close 1']);
});

test('a closed week is not closed or reported again', async () => {
  const store = memoryStore();
  const { run, claude } = setup(store);
  await run(new FakeServer(), 7);
  assert.equal(claude.length, 2);

  // The hook again on day 7, as a rerun would call it: the issue is closed, so nothing more.
  const { sink, events } = recordingSink();
  await sink.close({ week: 1, number: 1, closed: false });
  const reporter = createReporter({ run: async () => assert.fail('no call'), runId: 'x' });
  const profiles = [bot('one-en'), bot('two-en')];
  const states = new Map(await Promise.all(profiles.map(async (p) => [p.name, await store.load(p.name)] as const)));
  await weeklyIssue({ profiles, store, sink, reporter, log: () => {} })({ day: 7, states, played: [] });
  assert.deepEqual(events, ['close 1', 'open 1']);
});
