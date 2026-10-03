import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  categoryFromLabels,
  checkDecisions,
  parseCategoriesFile,
  type CategoriesFile,
  type TriageDecision,
} from './categories.ts';
import { knownIssuesSchema, type KnownIssue } from './knownIssues.ts';

function known(rows: { number: number; state?: string; labels?: string[] }[]): KnownIssue[] {
  return knownIssuesSchema.parse(
    rows.map((r) => ({
      number: r.number,
      title: `issue ${r.number}`,
      state: r.state ?? 'OPEN',
      labels: (r.labels ?? ['nightly-qa']).map((name) => ({ name })),
      body: '',
    })),
  );
}

function decision(over: Partial<TriageDecision> = {}): TriageDecision {
  return {
    issue: 66,
    category: 'ux-polish',
    confidence: 'high',
    rationale: 'Works; wording only.',
    evidence: [],
    ...over,
  };
}

const file = (decisions: TriageDecision[]): CategoriesFile => ({ decisions, rule_gaps: [] });

test('the category is read from its triage label, and an unlabelled issue has none', () => {
  assert.equal(categoryFromLabels(['nightly-qa', 'triage:real-bug']), 'real_bug');
  assert.equal(categoryFromLabels(['nightly-qa', 'bug']), null);
});

test('a well-formed file parses, with evidence and rule gaps defaulted', () => {
  const raw = JSON.stringify({
    decisions: [{ issue: 66, category: 'duplicate', duplicate_of: 28, confidence: 'high', rationale: 'same' }],
  });
  const parsed = parseCategoriesFile(raw);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.file.decisions[0].evidence, []);
    assert.deepEqual(parsed.file.rule_gaps, []);
  }
});

test('a missing file is refused, and says nothing was changed', () => {
  const parsed = parseCategoriesFile(null);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.error, /Nothing was changed/);
});

// Review Focus 3: what a model writes when it forgets it is writing a file.
test('a fenced or prose-wrapped file is refused as a whole, naming the file', () => {
  const fenced = '```json\n{"decisions":[],"rule_gaps":[]}\n```';
  const parsed = parseCategoriesFile(fenced);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.error, /categories\.json is not valid JSON/);
});

test('an unknown category fails the whole file, not one decision', () => {
  const raw = JSON.stringify({
    decisions: [{ issue: 66, category: 'wontfix', confidence: 'high', rationale: 'x' }],
  });
  const parsed = parseCategoriesFile(raw);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.error, /does not match the contract/);
});

test('a target with no decision is undecided, and a decision on a non-target is ignored', () => {
  const checked = checkDecisions(file([decision({ issue: 99 })]), [66], known([{ number: 66 }, { number: 99 }]));
  assert.deepEqual(checked.undecided, [66]);
  assert.equal(checked.ignored[0].issue, 99);
  assert.equal(checked.accepted.length, 0);
});

test('two decisions on one target refuse both', () => {
  const checked = checkDecisions(
    file([decision(), decision({ category: 'real_bug' })]),
    [66],
    known([{ number: 66 }]),
  );
  assert.equal(checked.refused.length, 2);
  assert.match(checked.refused[0].reason, /more than one decision/);
  assert.deepEqual(checked.undecided, []);
});

test('working-as-intended with no evidence is refused', () => {
  const checked = checkDecisions(
    file([decision({ category: 'working-as-intended' })]),
    [66],
    known([{ number: 66 }]),
  );
  assert.match(checked.refused[0].reason, /citation/);
});

test('a duplicate needs duplicate_of, pointing at an open issue that is not itself', () => {
  const issues = known([{ number: 66 }, { number: 28, state: 'CLOSED' }]);
  const missing = checkDecisions(file([decision({ category: 'duplicate' })]), [66], issues);
  assert.match(missing.refused[0].reason, /duplicate_of/);
  const self = checkDecisions(file([decision({ category: 'duplicate', duplicate_of: 66 })]), [66], issues);
  assert.match(self.refused[0].reason, /itself/);
  const closed = checkDecisions(file([decision({ category: 'duplicate', duplicate_of: 28 })]), [66], issues);
  assert.match(closed.refused[0].reason, /not an open nightly-qa issue/);
});

test('no chains: a duplicate of an issue being closed tonight is refused', () => {
  const issues = known([{ number: 66 }, { number: 28 }, { number: 10 }]);
  const checked = checkDecisions(
    file([
      decision({ issue: 66, category: 'duplicate', duplicate_of: 28 }),
      decision({ issue: 28, category: 'duplicate', duplicate_of: 10 }),
    ]),
    [66, 28],
    issues,
  );
  assert.deepEqual(checked.accepted.map((d) => d.issue), [28]);
  assert.match(checked.refused[0].reason, /itself being closed tonight/);
});

test('a low-confidence decision is accepted like any other', () => {
  const checked = checkDecisions(file([decision({ confidence: 'low' })]), [66], known([{ number: 66 }]));
  assert.equal(checked.accepted.length, 1);
});
