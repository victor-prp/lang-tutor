import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { WeekNumbers } from './analysis.ts';
import { closingComment, dailyComment, fileSink, ghSink, issueBody, issueTitle } from './issue.ts';
import { newLine } from './play.ts';
import type { ReportRecord } from './report.ts';
import { ROSTER } from './roster.ts';

/** A gh that answers from a table and remembers every call. Nothing is spawned. */
function fakeGh(answers: (args: readonly string[]) => string = () => '') {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args: readonly string[]) => {
      calls.push([...args]);
      return answers(args);
    },
  };
}

test('the issue is titled by its week and its body describes the roster', () => {
  assert.equal(issueTitle(3), 'Bots — simulated week 3');
  const body = issueBody(ROSTER);
  for (const p of ROSTER) assert.ok(body.includes(`| ${p.name} |`), p.name);
  assert.ok(body.includes('| silent-ru | ACT-R | Russian | 1–2 | every day | listening |'));
  assert.ok(body.includes('| skipper-en | ACT-R | English | 1 | 2 days in 3 | listening, speaking |'));
  assert.ok(body.includes('| control-it | FSRS-6 | Italian | 1–2 | every day | listening, speaking |'));
});

test('the daily comment has a line per bot', () => {
  const text = dailyComment(7, [
    {
      name: 'steady-en',
      line: { ...newLine(7), played: true, completed: true, sessions: 2, cards: 18, right: 15, newWords: 4, unheard: 1, noVoice: 0, unmatched: 1, failed: 0 },
    },
    { name: 'skipper-en', line: { ...newLine(7), played: false, completed: true } },
    {
      name: 'fast-ru',
      line: { ...newLine(7), played: true, completed: false, sessions: 1, cards: 5, right: 3, newWords: 2, failed: 1 },
    },
  ]);
  assert.equal(
    text,
    [
      '**Day 7** (2026-01-07)',
      '',
      '| Bot | Sessions | Cards | Right | New words | Unheard | No voice | Unmatched | Failed requests |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
      '| steady-en | 2 | 18 | 15 (83%) | 4 | 1 | 0 | 1 | 0 |',
      '| skipper-en | rested | | | | | | | |',
      '| fast-ru | 1 | 5 | 3 (60%) | 2 | 0 | 0 | 0 | 1, day not finished |',
      '',
    ].join('\n'),
  );
});

const numbers = (week: number, over: Partial<WeekNumbers> = {}): WeekNumbers => ({
  week,
  cards: 40,
  a: 1.4234,
  b: 0.5,
  c: { second: 1, third: 2.5, later: null },
  d: 0.1,
  e: 0.6181,
  ...over,
});

const report = (bot: string, week: number, costUsd: number, text = `I am ${bot}.`): ReportRecord => ({
  bot,
  week,
  runId: '99',
  text,
  costUsd,
  usage: { inputTokens: 10, outputTokens: 200, cacheReadTokens: 3000, cacheCreationTokens: 400 },
});

test('the closing comment: the five numbers against earlier weeks, the reports, the spend', () => {
  const text = closingComment(2, [
    {
      name: 'steady-en',
      weeks: [numbers(1, { a: null, c: { second: null, third: null, later: null } }), numbers(2)],
      reports: [report('steady-en', 1, 0.05), report('steady-en', 2, 0.0735, 'Too easy.\nThe same words.')],
    },
    {
      name: 'fast-ru',
      weeks: [numbers(2, { cards: 12, d: 0 })],
      reports: [{ ...report('fast-ru', 2, 0), text: '', error: 'claude failed: not logged in' }],
    },
  ]);
  assert.equal(
    text,
    [
      '## Week 2 closed',
      '',
      '### The five numbers',
      '',
      '(a) weak words\' share of cards over their share of the list: above 1 is the aim. (b) cards testing a word\'s weakest dimension. (c) median days between reviews right in a row, 2nd / 3rd / 4th+: rising is the aim. (d) cards off the rung that level and R imply: low is the aim. (e) mean true recall at the week\'s end: steady or rising is the aim.',
      '',
      '| Bot | Week | Cards | a | b | c | d | e |',
      '|---|---:|---:|---:|---:|---|---:|---:|',
      '| steady-en | 1 | 40 | – | 0.50 | – / – / – | 0.10 | 0.62 |',
      '| steady-en | 2 | 40 | 1.42 | 0.50 | 1 / 2.5 / – | 0.10 | 0.62 |',
      '| fast-ru | 2 | 12 | 1.42 | 0.50 | 1 / 2.5 / – | 0.00 | 0.62 |',
      '',
      '### Reports',
      '',
      '**steady-en**',
      '',
      '> Too easy.',
      '> The same words.',
      '',
      '**fast-ru**',
      '',
      '_No report: claude failed: not logged in_',
      '',
      '### Claude spend',
      '',
      '| Bot | This week | Input | Output | Cache read | Cache write |',
      '|---|---:|---:|---:|---:|---:|',
      '| steady-en | $0.0735 | 10 | 200 | 3000 | 400 |',
      '| fast-ru | $0.0000 | 10 | 200 | 3000 | 400 |',
      '| **Total** | **$0.0735** | | | | |',
      '',
      'Running total since day 1: $0.1235 over 3 report calls.',
      '',
    ].join('\n'),
  );
});

test('a week closed by a later run says so', () => {
  const late = closingComment(1, [{ name: 'b', weeks: [numbers(1, { e: null, late: true })], reports: [] }], { late: true });
  assert.equal(
    late.split('\n').slice(0, 4).join('\n'),
    [
      '## Week 1 closed',
      '',
      "_Closed by a later run: the week's last run did not finish closing it. A (e) of – is a week closed after later days were played, when the memory at its end was gone._",
      '',
    ].join('\n'),
  );
  assert.ok(late.includes('| b | 1 | 40 | 1.42 | 0.50 | 1 / 2.5 / – | 0.10 | – |'));
  assert.ok(!closingComment(1, []).includes('Closed by a later run'));
});

test('gh: the week\'s issue is created with its label when no issue has its title', async () => {
  const gh = fakeGh((args) =>
    args[1] === 'list'
      ? JSON.stringify([{ number: 40, title: 'Bots — simulated week 30', state: 'OPEN' }])
      : args[1] === 'create'
        ? 'https://github.com/victor-prp/lang-tutor/issues/42\n'
        : '',
  );
  const sink = ghSink(gh.run);
  const ref = await sink.open(3, 'the body');
  assert.deepEqual(ref, { week: 3, number: 42, closed: false });
  assert.deepEqual(gh.calls, [
    ['issue', 'list', '--label', 'bots', '--state', 'all', '--search', '"simulated week 3" in:title', '--json', 'number,title,state', '--limit', '50'],
    ['label', 'create', 'bots', '--color', '0e8a16', '--description', 'Weekly reports of the simulated learners', '--force'],
    ['issue', 'create', '--title', 'Bots — simulated week 3', '--label', 'bots', '--body', 'the body'],
  ]);

  await sink.comment(ref, 'a comment');
  await sink.close(ref);
  assert.deepEqual(gh.calls.slice(3), [
    ['issue', 'comment', '42', '--body', 'a comment'],
    ['issue', 'close', '42'],
  ]);
});

test('gh: an issue with the week\'s exact title is reused, open or closed', async () => {
  const gh = fakeGh(() =>
    JSON.stringify([
      { number: 40, title: 'Bots — simulated week 30', state: 'OPEN' },
      { number: 41, title: 'Bots — simulated week 3', state: 'CLOSED' },
    ]),
  );
  assert.deepEqual(await ghSink(gh.run).open(3, 'b'), { week: 3, number: 41, closed: true });
  assert.equal(gh.calls.length, 1);
});

test('a dry run writes the issue to a file, and files nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bots-issue-test-'));
  try {
    const sink = fileSink(dir);
    const ref = await sink.open(1, 'the roster');
    await sink.comment(ref, 'day 1');
    assert.deepEqual(await sink.open(1, 'the roster'), { week: 1, number: null, closed: false });
    await sink.close(ref);
    assert.equal((await sink.open(1, 'the roster')).closed, true);
    assert.equal(
      readFileSync(join(dir, 'week-1.md'), 'utf8'),
      '# Bots — simulated week 1\n\nLabel: bots\n\nthe roster\n\n---\n\nday 1\n\n---\n\n<!-- closed -->\n',
    );
    assert.equal(sink.where(ref), join(dir, 'week-1.md'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
