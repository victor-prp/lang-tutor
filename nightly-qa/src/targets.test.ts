import assert from 'node:assert/strict';
import { test } from 'node:test';

import { REPORT_LABEL, selectTargets, stripTriage, trackerSchema, type TrackerIssue } from './targets.ts';

function tracker(rows: { number: number; state?: string; labels?: string[]; body?: string }[]): TrackerIssue[] {
  return trackerSchema.parse(
    rows.map((r) => ({
      number: r.number,
      title: `issue ${r.number}`,
      state: r.state ?? 'OPEN',
      labels: (r.labels ?? ['nightly-qa']).map((name) => ({ name })),
      body: r.body ?? '',
      createdAt: '2026-10-01T00:00:00Z',
      comments: [],
    })),
  );
}

const none = { created: [], commented: [] };

test('an open issue with no category is a target; a categorised one is not', () => {
  const issues = tracker([{ number: 1 }, { number: 2, labels: ['nightly-qa', 'triage:ux-polish'] }]);
  assert.deepEqual(selectTargets(issues, none, 15).targets.map((i) => i.number), [1]);
});

test('a categorised issue commented on tonight is re-checked, and so is one created tonight', () => {
  const issues = tracker([
    { number: 1, labels: ['nightly-qa', 'triage:ux-polish'] },
    { number: 2, labels: ['nightly-qa', 'triage:real-bug'] },
  ]);
  const { targets } = selectTargets(issues, { created: [2], commented: [1] }, 15);
  assert.deepEqual(targets.map((i) => i.number), [1, 2]);
});

test('closed issues are never targets, even when commented on tonight', () => {
  const issues = tracker([{ number: 1, state: 'CLOSED' }]);
  assert.deepEqual(selectTargets(issues, { created: [], commented: [1] }, 15).targets, []);
});

// Review Focus 5: a report someone also labelled nightly-qa.
test('the report issue is never a target, whatever else it is labelled', () => {
  const issues = tracker([{ number: 1, labels: ['nightly-qa', REPORT_LABEL] }]);
  assert.deepEqual(selectTargets(issues, { created: [1], commented: [] }, 15).targets, []);
});

test('the cap takes the oldest first and carries the rest', () => {
  const issues = tracker([{ number: 30 }, { number: 10 }, { number: 20 }]);
  const { targets, carried } = selectTargets(issues, none, 2);
  assert.deepEqual(targets.map((i) => i.number), [10, 20]);
  assert.deepEqual(carried, [30]);
});

test('calibration strips every label and body line that would give the answer away', () => {
  const [issue] = tracker([
    {
      number: 66,
      labels: ['nightly-qa', 'bug', 'triage:duplicate', 'duplicate', 'by-design', 'known-issue'],
      body: 'Observed.\n\n**Duplicate of:** #28\n',
    },
  ]);
  const stripped = stripTriage(issue);
  assert.deepEqual(stripped.labels.map((l) => l.name), ['nightly-qa', 'bug']);
  assert.doesNotMatch(stripped.body, /Duplicate of/);
});
