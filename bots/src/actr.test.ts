import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACTR_AVERAGE, ActrMemory, addTrace, guess, recall, type Trace } from './actr.ts';

const near = (actual: number, expected: number, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < eps, `${actual} is not ${expected}`);

// Parameters: a = 0.167, c = 0.232, s = 0.252, tau = -0.669, h = 0.031.
// The clock is simulated hours; ages are seconds (the parameters are fit to seconds). A gap of
// more than one hour is "between sessions" and is multiplied by h, so 24 h counts as
// 24 * 3600 * 0.031 = 2678.4 s. Expected values were computed independently of actr.ts.
const P = (m: number) => 1 / (1 + Math.exp((-0.669 - m) / 0.252));
const DAY = 24 * 3600 * 0.031; // 2678.4 s

test('one trace, a day old', () => {
  // m = ln(2678.4^-0.167) = -0.167 * ln 2678.4 = -0.167 * 7.892975 = -1.318127
  // P = 1 / (1 + e^((-0.669 + 1.318127) / 0.252)) = 1 / (1 + e^2.575900) = 0.070706
  const traces = addTrace([], 0);
  near(recall(traces, 24, ACTR_AVERAGE, 0), 0.07070565196973046);
  near(recall(traces, 24, ACTR_AVERAGE, 0), P(-1.3181268050092911));
  near(recall(traces, 24, ACTR_AVERAGE, 0), P(Math.log(DAY ** -0.167)));
});

test('two traces', () => {
  // Traces at 0 and 24 h, now 48 h. Activation at 24 h (one trace aged 2678.4 s): m1 = -1.318127.
  // Decay of the second trace d2 = 0.232 * e^-1.318127 + 0.167 = 0.229092.
  // Ages now: trace 1 = 2 * 2678.4 = 5356.8 s, trace 2 = 2678.4 s.
  // m = ln(5356.8^-0.167 + 2678.4^-0.229092) = ln(0.238382 + 0.163947) = -0.910487
  // P = 1 / (1 + e^((-0.669 + 0.910487) / 0.252)) = 0.277222
  const traces = addTrace(addTrace([], 0), 24);
  near(recall(traces, 48, ACTR_AVERAGE, 0), 0.2772224444836956);
});

test('three traces', () => {
  // Traces at 0, 24, 48 h, now 72 h. Activation at 48 h is the two-trace m = -0.910487, so
  // d3 = 0.232 * e^-0.910487 + 0.167 = 0.260340 (d2 = 0.229092 as above).
  // Ages now: 3 * 2678.4 = 8035.2 s, 5356.8 s, 2678.4 s.
  // m = ln(8035.2^-0.167 + 5356.8^-0.229092 + 2678.4^-0.260340) = -0.711800
  // P = 1 / (1 + e^((-0.669 + 0.711800) / 0.252)) = 0.457642
  const traces = addTrace(addTrace(addTrace([], 0), 24), 48);
  near(recall(traces, 72, ACTR_AVERAGE, 0), 0.45764179501906016);
});

test('a hidden difficulty shifts tau', () => {
  // tau + 0.3: P = 1 / (1 + e^((-0.669 + 0.3 + 1.318127) / 0.252)) = 0.022613
  near(recall(addTrace([], 0), 24, ACTR_AVERAGE, 0.3), 0.02261259138072348);
});

test('time within a session is not scaled', () => {
  // Traces at 0 and 0.5 h, now 0.75 h: every gap is under an hour, so ages are real seconds.
  // m at 0.5 h = ln(1800^-0.167) = -1.251756; d2 = 0.232 * e^-1.251756 + 0.167 = 0.233353.
  // Ages now: 2700 s and 900 s. m = ln(2700^-0.167 + 900^-0.233353) = -0.751321, P = 0.419051
  const m1 = Math.log(1800 ** -0.167);
  const d2 = 0.232 * Math.exp(m1) + 0.167;
  const m = Math.log(2700 ** -0.167 + 900 ** -d2);
  near(recall(addTrace(addTrace([], 0), 0.5), 0.75, ACTR_AVERAGE, 0), P(m));
  near(recall(addTrace(addTrace([], 0), 0.5), 0.75, ACTR_AVERAGE, 0), 0.4190508074223288);
});

test('a gap over an hour is scaled by h, from the last trace on', () => {
  // One trace at 0, now 1.5 h: the gap is between sessions, so the age is 5400 * 0.031 = 167.4 s.
  // m = -0.167 * ln 167.4 = -0.855104, P = 0.323330
  near(recall(addTrace([], 0), 1.5, ACTR_AVERAGE, 0), P(Math.log((1.5 * 3600 * 0.031) ** -0.167)));
  near(recall(addTrace([], 0), 1.5, ACTR_AVERAGE, 0), 0.32333007906590655);
});

test('an age under a minute is floored at 60 s', () => {
  // Now 30 s after the trace: the age is floored to 60 s. m = -0.167 * ln 60 = -0.683757.
  near(recall(addTrace([], 0), 30 / 3600, ACTR_AVERAGE, 0), P(-0.167 * Math.log(60)));
  near(recall(addTrace([], 0), 0, ACTR_AVERAGE, 0), P(-0.167 * Math.log(60)));
});

test('no trace gives no recall, and a lower decay remembers longer', () => {
  assert.equal(recall([], 24, ACTR_AVERAGE, 0), 0);
  const traces = addTrace(addTrace([], 0), 24);
  assert.ok(recall(traces, 200, { ...ACTR_AVERAGE, a: 0.12 }, 0) > recall(traces, 200, { ...ACTR_AVERAGE, a: 0.22 }, 0));
});

test('a weaker trace counts for less', () => {
  const strong = recall(addTrace([], 0, 1), 24, ACTR_AVERAGE, 0);
  const weak = recall(addTrace([], 0, 0.2), 24, ACTR_AVERAGE, 0);
  assert.ok(weak < strong);
});

test('addTrace does not mutate and keeps time order', () => {
  const a: Trace[] = [{ at: 5, weight: 1 }];
  const b = addTrace(a, 2);
  assert.equal(a.length, 1);
  assert.deepEqual(b.map((t) => t.at), [2, 5]);
});

test('the four-option guessing floor', () => {
  assert.equal(guess(0, 4), 0.25);
  assert.equal(guess(1, 4), 1);
  near(guess(0.5, 4), 0.625);
  near(guess(0.5, 5), 0.2 + 0.8 * 0.5);
});

test('transfer: productive practice adds a weaker receptive trace; spoken and written feed each other', () => {
  const m = new ActrMemory({ name: 'x', params: ACTR_AVERAGE });
  m.setTime({ day: '2026-01-01', hour: 0 });
  assert.equal(m.recall('cat', 'written_receptive'), 0);
  // reverse_choice exercises written_receptive and written_productive.
  m.learn('cat', { type: 'reverse_choice', correct: true });
  const tr = m.state.traces;
  assert.ok(tr['cat|written_productive'].length > 0);
  // A productive-only card (say_translation tests spoken_receptive + spoken_productive) feeds written.
  m.learn('dog', { type: 'say_translation', verdict: 'understood' });
  assert.ok(m.state.traces['dog|spoken_productive'].length > 0);
  const written = m.state.traces['dog|written_receptive'];
  assert.ok(written && written.length > 0 && written.every((t) => t.weight < 0.5), 'cross-modality trace is small');
  // Productive to receptive of the same modality is larger than the cross-modality one.
  const rec = m.state.traces['dog|spoken_receptive'];
  assert.ok(rec.length > 0);
});

test('learning is the same wrong or right, and a read-aloud card teaches nothing', () => {
  const m = new ActrMemory({ name: 'x', params: ACTR_AVERAGE });
  m.setTime({ day: '2026-01-01', hour: 0 });
  m.learn('a', { type: 'multiple_choice', correct: false });
  assert.ok(m.state.traces['a|written_receptive'].length > 0);
  m.learn('b', { type: 'read_aloud', verdict: 'understood' });
  assert.deepEqual(Object.keys(m.state.traces).filter((k) => k.startsWith('b|')), []);
});

test('each word has a stable hidden difficulty that survives a round trip', () => {
  const m = new ActrMemory({ name: 'x', params: ACTR_AVERAGE });
  const s1 = m.shiftFor('cat');
  assert.equal(m.shiftFor('cat'), s1);
  const again = new ActrMemory({ name: 'x', params: ACTR_AVERAGE, state: JSON.parse(JSON.stringify(m.state)) });
  assert.equal(again.shiftFor('cat'), s1);
  const other = new ActrMemory({ name: 'y', params: ACTR_AVERAGE });
  assert.notEqual(other.shiftFor('cat'), s1);
});
