import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  issueNumberFromUrl,
  knownIssuesSchema,
  parseDuplicateOf,
  parseFingerprint,
  renderIssueBody,
  severityFromLabels,
  withDuplicateOf,
} from './knownIssues.ts';

test('parses the fingerprint back out of a rendered body', () => {
  const finding = {
    id: 'f1',
    severity: 'bug' as const,
    confidence: 'high' as const,
    title: 'Only the top sense renders',
    screen: 'dictionary',
    steps: ['open the dictionary', 'type bank'],
    expected: 'all senses reachable',
    observed: 'one sense, no control',
    evidence: { screenshots: [], network: 'POST /api/translations -> 4 senses', console: [] },
    fingerprint: 'dictionary | senses list | hidden-behind-tap',
  };
  const body = renderIssueBody(finding, {
    date: '2026-09-17',
    persona: 'careful-adult',
    focus: 'polysemy',
    browser_ok: true,
  });
  assert.equal(parseFingerprint(body), 'dictionary | senses list | hidden-behind-tap');
});

test('a body with no fingerprint line parses as null', () => {
  assert.equal(parseFingerprint('Some human wrote this issue by hand.'), null);
});

test('the fingerprint line is matched even with other backticks in the body', () => {
  const body = 'Steps: run `npm test`\n\n**Fingerprint:** `home | route navigation | lost-session`\n';
  assert.equal(parseFingerprint(body), 'home | route navigation | lost-session');
});

test('reads the severity back off the labels', () => {
  assert.equal(severityFromLabels(['nightly-qa', 'bug']), 'bug');
  assert.equal(severityFromLabels(['nightly-qa', 'inconvenience']), 'inconvenience');
  assert.equal(severityFromLabels(['nightly-qa']), null);
});

test('accepts the shape gh produces', () => {
  const parsed = knownIssuesSchema.parse([
    {
      number: 42,
      title: '[nightly-qa] Only the top sense renders',
      state: 'OPEN',
      labels: [{ name: 'nightly-qa' }, { name: 'bug' }],
      body: '**Fingerprint:** `dictionary | senses list | hidden-behind-tap`',
    },
  ]);
  assert.equal(parsed[0].number, 42);
  assert.equal(parsed[0].state, 'open');
  assert.deepEqual(parsed[0].labels, ['nightly-qa', 'bug']);
  assert.equal(parsed[0].fingerprint, 'dictionary | senses list | hidden-behind-tap');
  assert.equal(parsed[0].severity, 'bug');
});

test('an issue a human opened, with no fingerprint and no severity label, still parses', () => {
  const parsed = knownIssuesSchema.parse([
    { number: 7, title: 'something', state: 'CLOSED', labels: [{ name: 'nightly-qa' }], body: '' },
  ]);
  assert.equal(parsed[0].fingerprint, null);
  assert.equal(parsed[0].severity, null);
  assert.equal(parsed[0].state, 'closed');
});

test('the duplicate line round-trips through the body', () => {
  const body = withDuplicateOf('Found by the nightly QA agent.\n\n**Fingerprint:** `a | b | c`\n', 28);
  assert.equal(parseDuplicateOf(body), 28);
  assert.equal(parseFingerprint(body), 'a | b | c');
});

// Review Focus 4: gh returns null for an issue opened with no body.
test('a null or empty body becomes just the duplicate line', () => {
  assert.equal(withDuplicateOf(null, 28), '**Duplicate of:** #28\n');
  assert.equal(withDuplicateOf('', 28), '**Duplicate of:** #28\n');
  assert.equal(parseDuplicateOf(withDuplicateOf(null, 28)), 28);
});

test('a body with no duplicate line parses as null', () => {
  assert.equal(parseDuplicateOf('Duplicate of #28, said a human in prose.'), null);
});

test('a known issue carries its category and its original', () => {
  const [issue] = knownIssuesSchema.parse([
    {
      number: 66,
      title: 't',
      state: 'CLOSED',
      labels: [{ name: 'nightly-qa' }, { name: 'triage:duplicate' }],
      body: '**Duplicate of:** #28',
    },
  ]);
  assert.equal(issue.category, 'duplicate');
  assert.equal(issue.duplicateOf, 28);
});

test('the issue number is read from the URL gh prints', () => {
  assert.equal(issueNumberFromUrl('https://github.com/victor-prp/lang-tutor/issues/69\n'), 69);
  assert.equal(issueNumberFromUrl(''), null);
});
