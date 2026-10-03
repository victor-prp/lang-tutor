import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { compare, parseCsv, parseExamples, toSeedDecisions } from './examples.ts';

const HEADER = 'issue,title,qa_label,fingerprint,category,action,rationale';

// Review Focus 1: the real rows, quotes, commas and Hebrew included.
test('fields with commas, doubled quotes and Hebrew parse to exactly the cell text', () => {
  const rows = parseCsv(
    `${HEADER}\n` +
      `51,"'תרגל שוב' (practice again) restarts, with the same question",weird,"session | practice-again restart | duplicate-entry",missing-feature,leave open,"Pool is the fixed 10-word set; he said ""again"""\n`,
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[1][1], "'תרגל שוב' (practice again) restarts, with the same question");
  assert.equal(rows[1][6], 'Pool is the fixed 10-word set; he said "again"');
});

test('CRLF line endings and a trailing newline add no empty row', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('the checked-in examples.csv parses into 34 rows of 7 fields', () => {
  const rows = parseExamples(readFileSync(new URL('../triage/examples.csv', import.meta.url), 'utf8'));
  assert.equal(rows.length, 34);
});

test('a wrong header is refused', () => {
  assert.throws(() => parseExamples('issue,title\n1,x\n'), /header/);
});

test('seed decisions skip already-closed rows and read duplicate_of from the action', () => {
  const rows = parseExamples(
    `${HEADER}\n` +
      `66,t,bug,f,duplicate,close with note: duplicate of #28,same\n` +
      `34,t,bug,f,n/a (already closed),none,closed\n` +
      `61,t,bug,f,real_bug,to_be_fixed,contract\n`,
  );
  const decisions = toSeedDecisions(rows);
  assert.deepEqual(
    decisions.map((d) => [d.issue, d.category, d.duplicate_of]),
    [
      [66, 'duplicate', 28],
      [61, 'real_bug', undefined],
    ],
  );
  assert.equal(decisions[0].confidence, 'high');
  assert.ok(decisions[0].evidence.length > 0);
});

test('a duplicate row with no issue number in its action is refused', () => {
  const rows = parseExamples(`${HEADER}\n66,t,bug,f,duplicate,close it,same\n`);
  assert.throws(() => toSeedDecisions(rows), /#66/);
});

test('comparison counts agreement, flags a wrong close, and lists what is missing', () => {
  const rows = parseExamples(
    `${HEADER}\n` +
      `1,t,bug,f,ux-polish,leave open,r\n` +
      `2,t,bug,f,ux-polish,leave open,r\n` +
      `3,t,bug,f,real_bug,to_be_fixed,r\n`,
  );
  const result = compare(rows, [
    { issue: 1, category: 'ux-polish', confidence: 'high', rationale: 'r', evidence: [] },
    { issue: 2, category: 'working-as-intended', confidence: 'high', rationale: 'r', evidence: ['x'] },
  ]);
  assert.equal(result.total, 3);
  assert.equal(result.agreed, 1);
  assert.deepEqual(result.wrongCloses, [2]);
  assert.deepEqual(result.missing, [3]);
});

test('excluded issues are left out of the comparison', () => {
  const rows = parseExamples(`${HEADER}\n1,t,bug,f,ux-polish,leave open,r\n2,t,bug,f,ux-polish,leave open,r\n`);
  const result = compare(rows, [], new Set([1]));
  assert.equal(result.total, 1);
  assert.deepEqual(result.missing, [2]);
});
