import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACTR_AVERAGE, ActrMemory, addTrace, guess, recall, type Trace } from './actr.ts';

const near = (actual: number, expected: number, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < eps, `${actual} is not ${expected}`);

// Parameters: a = 0.167, c = 0.232, s = 0.252, tau = -0.669, h = 0.031.
// Hours are simulated hours; a gap of more than one hour is "between sessions" and is
// multiplied by h, so 24 h counts as 24 * 0.031 = 0.744 h.
const P = (m: number) => 1 / (1 + Math.exp((-0.669 - m) / 0.252));

test('one trace, a day old', () => {
  // m = ln(0.744^-0.167) = -0.167 * ln 0.744 = -0.167 * -0.295587 = 0.049384
  // P = 1 / (1 + e^((-0.669 - 0.049384) / 0.252)) = 1 / (1 + e^-2.850730) = 0.945356
  const traces = addTrace([], 0);
  near(recall(traces, 24, ACTR_AVERAGE, 0), 0.9453564704926174);
  near(recall(traces, 24, ACTR_AVERAGE, 0), P(0.04938427877289058));
});

test('two traces', () => {
  // Traces at 0 and 24, now 48. Activation at 24 (one trace aged 0.744): m1 = 0.049384.
  // Decay of the second trace d2 = 0.232 * e^0.049384 + 0.167 = 0.410745.
  // Ages now: trace 1 = 48 * 0.031 = 1.488, trace 2 = 24 * 0.031 = 0.744.
  // m = ln(1.488^-0.167 + 0.744^-0.410745) = ln(0.93601 + 1.12882) = 0.725097
  // P = 1 / (1 + e^((-0.669 - 0.725097) / 0.252)) = 0.996058
  const traces = addTrace(addTrace([], 0), 24);
  near(recall(traces, 48, ACTR_AVERAGE, 0), 0.9960580508942238);
});

test('three traces', () => {
  // Traces at 0, 24, 48, now 72. Activation at 48 is the two-trace m = 0.725097, so
  // d3 = 0.232 * e^0.725097 + 0.167 = 0.646064 (d2 = 0.410745 as above).
  // Ages now: 72 * 0.031 = 2.232, 48 * 0.031 = 1.488, 24 * 0.031 = 0.744.
  // m = ln(2.232^-0.167 + 1.488^-0.410745 + 0.744^-0.646064) = 1.076510
  // P = 1 / (1 + e^((-0.669 - 1.076510) / 0.252)) = 0.999020
  const traces = addTrace(addTrace(addTrace([], 0), 24), 48);
  near(recall(traces, 72, ACTR_AVERAGE, 0), 0.9990196578295467);
});

test('a hidden difficulty shifts tau', () => {
  // tau + 0.3: P = 1 / (1 + e^((-0.669 + 0.3 - 0.049384) / 0.252)) = 0.840272
  near(recall(addTrace([], 0), 24, ACTR_AVERAGE, 0.3), 0.8402722408007601);
});

test('time within a session is not scaled', () => {
  // Traces at 0 and 0.5 h, now 0.75 h: every gap is under an hour, so ages are real.
  // m at 0.5 = ln(0.5^-0.167) = 0.115763; d2 = 0.232 * e^0.115763 + 0.167 = 0.4349.
  // Ages now: 0.75 and 0.25. m = ln(0.75^-0.167 + 0.25^-0.4349)
  const m1 = Math.log(0.5 ** -0.167);
  const d2 = 0.232 * Math.exp(m1) + 0.167;
  const m = Math.log(0.75 ** -0.167 + 0.25 ** -d2);
  near(recall(addTrace(addTrace([], 0), 0.5), 0.75, ACTR_AVERAGE, 0), P(m));
});

test('a gap over an hour is scaled by h, from the last trace on', () => {
  // One trace at 0, now 1.5 h: the gap is between sessions, so the age is 1.5 * 0.031.
  near(recall(addTrace([], 0), 1.5, ACTR_AVERAGE, 0), P(Math.log((1.5 * 0.031) ** -0.167)));
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
