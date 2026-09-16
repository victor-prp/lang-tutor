import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { decide, severityRank, type Action } from './filing.ts';
import { parseReport, parseReportLoose, type QaReport } from './findings.ts';
import { knownIssuesSchema, type KnownIssue } from './knownIssues.ts';

// Narrowing helpers. `assert.equal(a.kind, 'skip')` satisfies the runtime but
// not tsc, which still sees the union and rejects `.reason` - and typecheck runs
// over this workspace, so without these the suite passes and the build fails.
const expectSkip = (a: Action) => {
  assert.equal(a.kind, 'skip');
  return a as Extract<Action, { kind: 'skip' }>;
};
const expectComment = (a: Action) => {
  assert.equal(a.kind, 'comment');
  return a as Extract<Action, { kind: 'comment' }>;
};
const expectCreate = (a: Action) => {
  assert.equal(a.kind, 'create');
  return a as Extract<Action, { kind: 'create' }>;
};

const run = { date: '2026-09-17', persona: 'careful-adult', focus: 'polysemy', browser_ok: true };

function finding(over: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    severity: 'bug',
    confidence: 'high',
    title: 'Only the top sense renders',
    screen: 'dictionary',
    steps: ['open the dictionary', 'type bank'],
    expected: 'all senses reachable',
    observed: 'one sense, no control',
    evidence: { screenshots: [], network: 'POST /api/translations -> 4 senses', console: [] },
    fingerprint: 'dictionary | senses list | hidden-behind-tap',
    ...over,
  };
}

function report(findings: Record<string, unknown>[]): QaReport {
  return parseReport({ run, coverage: [], findings, notes: '' });
}

function issues(rows: Partial<Record<string, unknown>>[]): KnownIssue[] {
  return knownIssuesSchema.parse(
    rows.map((r, i) => ({
      number: r.number ?? i + 1,
      title: r.title ?? 'an issue',
      state: r.state ?? 'OPEN',
      labels: (r.labels as string[] | undefined)?.map((name) => ({ name })) ?? [
        { name: 'nightly-qa' },
        { name: 'bug' },
      ],
      body: r.body ?? '**Fingerprint:** `dictionary | senses list | hidden-behind-tap`',
    })),
  );
}

const limits = { maxNew: 3 };

test('a low-confidence finding is never filed', () => {
  const { actions } = decide(report([finding({ confidence: 'low', match: { new: true } })]), [], limits);
  assert.match(expectSkip(actions[0]).reason, /confidence/);
});

test('a finding with no match at all is not filed, and says why', () => {
  const { actions } = decide(report([finding()]), [], limits);
  assert.match(expectSkip(actions[0]).reason, /no deduplication decision/);
});

test('a match against an open issue comments on it', () => {
  const known = issues([{ number: 42, state: 'OPEN' }]);
  const { actions } = decide(report([finding({ match: { issue: 42 } })]), known, limits);
  const comment = expectComment(actions[0]);
  assert.equal(comment.issue, 42);
  assert.equal(comment.reopened, false);
});

test('severity escalates when the finding is worse than the issue on record', () => {
  const known = issues([{ number: 42, state: 'OPEN', labels: ['nightly-qa', 'weird'] }]);
  const { actions } = decide(report([finding({ severity: 'bug', match: { issue: 42 } })]), known, limits);
  assert.equal(expectComment(actions[0]).escalateTo, 'bug');
});

test('severity never falls: a quieter night does not shrink a known bug', () => {
  const known = issues([{ number: 42, state: 'OPEN', labels: ['nightly-qa', 'bug'] }]);
  const { actions } = decide(
    report([finding({ severity: 'inconvenience', match: { issue: 42 } })]),
    known,
    limits,
  );
  assert.equal(expectComment(actions[0]).escalateTo, undefined);
});

test('a match against an issue closed as by-design is dropped without comment', () => {
  const known = issues([{ number: 42, state: 'CLOSED', labels: ['nightly-qa', 'by-design'] }]);
  const { actions } = decide(report([finding({ match: { issue: 42 } })]), known, limits);
  assert.match(expectSkip(actions[0]).reason, /by-design/);
});

test('a match against an issue closed for any other reason comments that it came back', () => {
  const known = issues([{ number: 42, state: 'CLOSED', labels: ['nightly-qa', 'bug'] }]);
  const { actions } = decide(report([finding({ match: { issue: 42 } })]), known, limits);
  assert.equal(expectComment(actions[0]).reopened, true);
});

test('a match against an issue number that does not exist is not filed', () => {
  const { actions } = decide(report([finding({ match: { issue: 999 } })]), issues([{ number: 42 }]), limits);
  assert.match(expectSkip(actions[0]).reason, /999/);
});

test('a new finding is created', () => {
  const { actions } = decide(report([finding({ match: { new: true } })]), [], limits);
  assert.deepEqual(expectCreate(actions[0]).possibleDuplicateOf, []);
});

test('creations are capped, bugs first, and the overflow says it was the cap', () => {
  const many = [
    finding({ id: 'a', severity: 'inconvenience', match: { new: true } }),
    finding({ id: 'b', severity: 'bug', match: { new: true } }),
    finding({ id: 'c', severity: 'weird', match: { new: true } }),
    finding({ id: 'd', severity: 'bug', match: { new: true } }),
  ];
  const { actions } = decide(report(many), [], { maxNew: 2 });
  const created = actions.filter((a) => a.kind === 'create').map((a) => a.finding.id);
  assert.deepEqual(created, ['b', 'd']);
  const skipped = actions.filter((a) => a.kind === 'skip') as Extract<Action, { kind: 'skip' }>[];
  assert.equal(skipped.length, 2);
  for (const s of skipped) assert.match(s.reason, /cap/);
});

test('a new finding whose exact fingerprint is already open is flagged, not blocked', () => {
  const known = issues([
    { number: 42, state: 'OPEN', body: '**Fingerprint:** `dictionary | senses list | hidden-behind-tap`' },
  ]);
  const { actions } = decide(report([finding({ match: { new: true } })]), known, limits);
  assert.deepEqual(expectCreate(actions[0]).possibleDuplicateOf, [42]);
});

test('THE TRAP: same screen and element, different symptom, is not flagged as a duplicate', () => {
  const known = issues([
    { number: 42, state: 'OPEN', body: '**Fingerprint:** `dictionary | senses list | duplicate-entry`' },
  ]);
  const { actions, neighbours } = decide(
    report([finding({ fingerprint: 'dictionary | senses list | hidden-behind-tap', match: { new: true } })]),
    known,
    limits,
  );
  assert.deepEqual(
    expectCreate(actions[0]).possibleDuplicateOf,
    [],
    'must not flag: these are two different problems',
  );
  assert.equal(neighbours.length, 1, 'but a human should still see they are neighbours');
  assert.equal(neighbours[0].issue, 42);
});

test('fingerprint comparison ignores spacing and case', () => {
  const known = issues([
    { number: 42, state: 'OPEN', body: '**Fingerprint:** `Dictionary|Senses List|hidden-behind-tap`' },
  ]);
  const { actions } = decide(report([finding({ match: { new: true } })]), known, limits);
  assert.deepEqual(expectCreate(actions[0]).possibleDuplicateOf, [42]);
});

test('severityRank orders bug above weird above inconvenience', () => {
  assert.ok(severityRank('bug') > severityRank('weird'));
  assert.ok(severityRank('weird') > severityRank('inconvenience'));
});

// --- the real runs -----------------------------------------------------------
// These are part A's two sessions. What makes them worth testing against is
// exactly what invented fixtures smooth over: the same defect written up two
// different ways on two different nights.

const clean = parseReport(JSON.parse(readFileSync('src/fixtures/run-clean.json', 'utf8')));

// parseReportLoose, not parseReport: this run carried one finding with no
// evidence at all, and the strict parser rejects the whole document for it. That
// is exactly the case parseReportLoose exists for, and the fixture is worth
// keeping unedited because a real night really does produce one.
const plantedParse = parseReportLoose(
  JSON.parse(readFileSync('src/fixtures/run-planted.json', 'utf8')),
);

test('both real runs parse and carry no match field, so nothing files by accident', () => {
  assert.equal(clean.findings.length, 5);
  assert.equal(plantedParse.report.findings.length, 5);
  assert.equal(plantedParse.dropped.length, 1, 'the planted run carried one unevidenced finding');
  const { actions } = decide(clean, [], limits);
  assert.ok(actions.every((a) => a.kind === 'skip'));
});

test('a real run with every finding marked new files exactly the cap, bugs first', () => {
  const marked = parseReport({
    ...clean,
    findings: clean.findings.map((f) => ({ ...f, match: { new: true } })),
  });
  const { actions } = decide(marked, [], limits);
  const created = actions.filter((a) => a.kind === 'create') as Extract<Action, { kind: 'create' }>[];
  assert.equal(created.length, 3);
  assert.ok(created.every((a) => a.finding.severity === 'bug'));
});
