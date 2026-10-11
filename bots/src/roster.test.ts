import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACTR_AVERAGE, addTrace, recall, type ActrParams, type Trace } from './actr.ts';
import { ACTR_FAST, ACTR_FORGETFUL, ROSTER, lookupsToday, playsToday, sessionHours } from './roster.ts';
import { rngFor } from './rng.ts';

test('the six bots of D13, with valid names', () => {
  assert.deepEqual(ROSTER.map((b) => b.name), [
    'steady-en',
    'fast-ru',
    'forgetful-it',
    'skipper-en',
    'silent-ru',
    'control-it',
  ]);
  for (const b of ROSTER) assert.match(b.name, /^[a-z0-9-]{3,30}$/);
});

test('languages, memories and devices follow the table', () => {
  const by = Object.fromEntries(ROSTER.map((b) => [b.name, b]));
  assert.equal(by['steady-en'].language, 'en');
  assert.equal(by['fast-ru'].language, 'ru');
  assert.equal(by['forgetful-it'].language, 'it');
  assert.equal(by['control-it'].memory, 'fsrs');
  assert.equal(by['silent-ru'].devices.speaking, false);
  assert.equal(by['steady-en'].devices.speaking, true);
  assert.ok(by['fast-ru'].actr!.a < by['steady-en'].actr!.a, 'low decay');
  assert.ok(by['forgetful-it'].actr!.a > by['steady-en'].actr!.a, 'high decay');
  assert.equal(by['control-it'].actr, undefined);
});

test('sessions a day stay in range and sit at simulated hours', () => {
  for (const b of ROSTER) {
    for (let day = 0; day < 60; day++) {
      const hours = sessionHours(b, rngFor(b.name, day));
      assert.ok(hours.length >= b.sessions[0] && hours.length <= b.sessions[1], `${b.name} ${hours}`);
      assert.deepEqual([...hours].sort((x, y) => x - y), hours);
      assert.ok(hours.every((h) => h >= 8 && h <= 20));
    }
  }
  assert.deepEqual(sessionHours({ ...ROSTER[0], sessions: [2, 2] }, rngFor('x', 1)), [8, 20]);
  assert.deepEqual(sessionHours({ ...ROSTER[0], sessions: [1, 1] }, rngFor('x', 1)), [8]);
});

test('skipper plays about two days in three, the rest every day', () => {
  const by = Object.fromEntries(ROSTER.map((b) => [b.name, b]));
  let played = 0;
  for (let day = 0; day < 600; day++) if (playsToday(by['skipper-en'], rngFor('skipper-en', day))) played++;
  assert.ok(played > 330 && played < 470, `played ${played}`);
  for (let day = 0; day < 50; day++) assert.ok(playsToday(by['steady-en'], rngFor('steady-en', day)));
});

test('lookups are two to six a day, with a rare burst of thirty', () => {
  let burst = 0;
  for (let day = 0; day < 2000; day++) {
    const n = lookupsToday(ROSTER[0], rngFor('steady-en', day));
    if (n === 30) burst++;
    else assert.ok(n >= 2 && n <= 6, String(n));
  }
  assert.ok(burst > 0 && burst < 100, `bursts ${burst}`);
});

test('each ACT-R profile keeps its character with ages in seconds', () => {
  // A word answered at 08:00 each day for a week: a trace and the 0.5 seen-answer trace a day.
  let week: Trace[] = [];
  for (let d = 0; d < 7; d++) week = addTrace(addTrace(week, d * 24 + 8), d * 24 + 8.01, 0.5);
  const once = addTrace(addTrace([], 8), 8.01, 0.5);
  const nextDay = (p: ActrParams) => recall(week, 7 * 24 + 8, p);
  const weekLater = (p: ActrParams) => recall(week, 13 * 24 + 8, p);

  assert.ok(nextDay(ACTR_AVERAGE) > 0.8, `average after a week of practice: ${nextDay(ACTR_AVERAGE)}`);
  for (const days of [1, 2, 3]) assert.ok(recall(once, 8 + days * 24, ACTR_AVERAGE) < 0.7, `met once, ${days} days`);
  // The fast learner forgets slower than average, the forgetful one faster.
  assert.ok(nextDay(ACTR_FAST) > nextDay(ACTR_AVERAGE) && nextDay(ACTR_AVERAGE) > nextDay(ACTR_FORGETFUL));
  assert.ok(weekLater(ACTR_FAST) > weekLater(ACTR_AVERAGE) && weekLater(ACTR_AVERAGE) > weekLater(ACTR_FORGETFUL));
  // The forgetful bot still learns: a week of daily practice lifts it well above a single meeting.
  assert.ok(nextDay(ACTR_FORGETFUL) > 0.6, `forgetful after a week: ${nextDay(ACTR_FORGETFUL)}`);
  const by = Object.fromEntries(ROSTER.map((b) => [b.name, b]));
  assert.equal(by['fast-ru'].actr, ACTR_FAST);
  assert.equal(by['forgetful-it'].actr, ACTR_FORGETFUL);
});
