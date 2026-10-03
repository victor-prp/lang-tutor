import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TriageDecision } from './categories.ts';
import { knownIssuesSchema, type KnownIssue } from './knownIssues.ts';
import { labelCommands, planChanges, triageComment } from './triage.ts';

function known(labels: string[], body: string | null = 'Observed.'): KnownIssue[] {
  return knownIssuesSchema.parse([
    { number: 66, title: 't', state: 'OPEN', labels: labels.map((name) => ({ name })), body },
  ]);
}

function decision(over: Partial<TriageDecision> = {}): TriageDecision {
  return { issue: 66, category: 'ux-polish', confidence: 'high', rationale: 'Works; wording only.', evidence: [], ...over };
}

const verbs = (commands: string[][]) => commands.map((c) => `${c[0]} ${c[1]}`);

test('a first ux-polish decision labels, comments, and leaves the issue open', () => {
  const [change] = planChanges([decision()], known(['nightly-qa', 'bug']));
  assert.deepEqual(verbs(change.commands), ['issue edit', 'issue comment']);
  assert.deepEqual(change.commands[0], ['issue', 'edit', '66', '--add-label', 'triage:ux-polish', '--add-label', 'known-issue']);
  assert.equal(change.action, 'labelled');
});

test('a duplicate gets the body line, a comment, and a not-planned close, in that order', () => {
  const [change] = planChanges([decision({ category: 'duplicate', duplicate_of: 28 })], known(['nightly-qa']));
  assert.deepEqual(verbs(change.commands), ['issue edit', 'issue edit', 'issue comment', 'issue close']);
  assert.deepEqual(change.commands[1], ['issue', 'edit', '66', '--body', 'Observed.\n\n**Duplicate of:** #28\n']);
  assert.deepEqual(change.commands[3], ['issue', 'close', '66', '--reason', 'not planned']);
  assert.equal(change.action, 'closed as duplicate of #28');
});

test('working-as-intended adds by-design and closes', () => {
  const [change] = planChanges(
    [decision({ category: 'working-as-intended', evidence: ['apps/mobile/src/hooks/useSession.tsx:184'] })],
    known(['nightly-qa']),
  );
  assert.ok(change.commands[0].includes('by-design'));
  assert.deepEqual(change.commands.at(-1), ['issue', 'close', '66', '--reason', 'not planned']);
});

test('an unchanged category does nothing at all: no labels, no comment', () => {
  const [change] = planChanges([decision()], known(['nightly-qa', 'triage:ux-polish', 'known-issue']));
  assert.deepEqual(change.commands, []);
  assert.equal(change.action, 'unchanged');
});

test('leaving ux-polish removes known-issue and says it was recategorised', () => {
  const [change] = planChanges(
    [decision({ category: 'real_bug' })],
    known(['nightly-qa', 'triage:ux-polish', 'known-issue']),
  );
  assert.deepEqual(change.commands[0], [
    'issue', 'edit', '66',
    '--add-label', 'triage:real-bug',
    '--remove-label', 'triage:ux-polish',
    '--remove-label', 'known-issue',
  ]);
  assert.match(change.commands[1].at(-1) ?? '', /recategorised from `ux-polish` to `real_bug`/);
  assert.equal(change.action, 'recategorised');
});

// Review Focus 2: a human left two category labels on it.
test('a stray second triage label is removed, leaving exactly the decided one', () => {
  const [change] = planChanges(
    [decision()],
    known(['nightly-qa', 'triage:ux-polish', 'triage:real-bug', 'known-issue']),
  );
  assert.deepEqual(change.commands, [['issue', 'edit', '66', '--remove-label', 'triage:real-bug']]);
  assert.equal(change.action, 'labels repaired');
});

test('the comment starts with **Triage**, links the original, and marks low confidence', () => {
  const text = triageComment(
    decision({ category: 'duplicate', duplicate_of: 28, confidence: 'low', evidence: ['#28', 'apps/x.ts:1'] }),
    null,
  );
  assert.ok(text.startsWith('**Triage**'));
  assert.match(text, /Duplicate of #28\./);
  assert.match(text, /#28, `apps\/x\.ts:1`/);
  assert.match(text, /Low confidence/);
});

test('label creation covers every category label, known-issue and the report label', () => {
  const created = labelCommands().map((c) => c[2]);
  for (const name of ['triage:real-bug', 'triage:ux-polish', 'known-issue', 'nightly-qa-triage-report']) {
    assert.ok(created.includes(name), name);
  }
  assert.ok(labelCommands().every((c) => c.includes('--force')));
});
