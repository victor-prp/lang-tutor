import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normal, pick, rngFor, seedFrom } from './rng.ts';

const draws = (r: () => number, n: number) => Array.from({ length: n }, () => r());

test('the same name and day give the same draws', () => {
  assert.deepEqual(draws(rngFor('steady-en', 12), 20), draws(rngFor('steady-en', 12), 20));
});

test('another day or another name gives other draws', () => {
  const base = draws(rngFor('steady-en', 12), 5);
  assert.notDeepEqual(base, draws(rngFor('steady-en', 13), 5));
  assert.notDeepEqual(base, draws(rngFor('fast-ru', 12), 5));
});

test('draws lie in [0, 1) and spread out', () => {
  const xs = draws(rngFor('fast-ru', 1), 2000);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05, `mean ${mean}`);
});

test('seedFrom is a stable 32-bit integer', () => {
  assert.equal(seedFrom('a'), seedFrom('a'));
  assert.notEqual(seedFrom('a'), seedFrom('b'));
  assert.ok(Number.isInteger(seedFrom('hello')) && seedFrom('hello') >= 0 && seedFrom('hello') < 2 ** 32);
});

test('pick and normal are driven by the rng alone', () => {
  assert.equal(pick(() => 0.99, ['a', 'b', 'c']), 'c');
  assert.equal(pick(() => 0, ['a', 'b', 'c']), 'a');
  const xs = draws(() => normal(rngFor('x', 1)), 1);
  assert.ok(Number.isFinite(xs[0]));
  const r = rngFor('z', 3);
  const ns = Array.from({ length: 4000 }, () => normal(r));
  const mean = ns.reduce((a, b) => a + b, 0) / ns.length;
  const sd = Math.sqrt(ns.reduce((a, b) => a + (b - mean) ** 2, 0) / ns.length);
  assert.ok(Math.abs(mean) < 0.06 && Math.abs(sd - 1) < 0.06, `mean ${mean} sd ${sd}`);
});
