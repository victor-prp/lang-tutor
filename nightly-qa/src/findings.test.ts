import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseReport } from './findings.ts';

const validFinding = {
  id: 'f1',
  severity: 'inconvenience',
  confidence: 'high',
  title: 'Top meaning shown alone; the rest sit behind a more button',
  screen: 'dictionary',
  steps: ['log in', 'open the dictionary', 'type window', 'submit'],
  expected: 'all meanings visible, most common first',
  observed: 'one card, and a button revealing three others',
  evidence: {
    screenshots: ['shots/f1.png'],
    network: 'POST /api/translations -> 4 senses',
    console: [],
  },
  fingerprint: 'dictionary | senses list | only top sense before more',
};

const validReport = {
  run: { date: '2026-09-16', persona: 'careful-adult', focus: 'polysemy', browser_ok: true },
  coverage: ['created an account', 'looked up 6 words'],
  findings: [validFinding],
  notes: '',
};

test('accepts a well-formed report', () => {
  const parsed = parseReport(validReport);
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].severity, 'inconvenience');
  assert.equal(parsed.run.browser_ok, true);
});

test('accepts a report with no findings at all', () => {
  const parsed = parseReport({ ...validReport, findings: [] });
  assert.equal(parsed.findings.length, 0);
});

test('accepts browser_ok false, so a run with no browser is representable', () => {
  const parsed = parseReport({
    ...validReport,
    run: { ...validReport.run, browser_ok: false },
    findings: [],
  });
  assert.equal(parsed.run.browser_ok, false);
});

test('rejects an unknown severity', () => {
  const bad = { ...validReport, findings: [{ ...validFinding, severity: 'catastrophe' }] };
  assert.throws(() => parseReport(bad));
});

test('rejects a finding with no evidence of any kind', () => {
  const bad = {
    ...validReport,
    findings: [{ ...validFinding, evidence: { screenshots: [], console: [] } }],
  };
  assert.throws(() => parseReport(bad), /evidence/);
});

test('rejects a finding with no steps, since a finding must be reproducible', () => {
  const bad = { ...validReport, findings: [{ ...validFinding, steps: [] }] };
  assert.throws(() => parseReport(bad));
});

test('defaults the optional evidence arrays and notes', () => {
  const sparse = {
    run: validReport.run,
    coverage: [],
    findings: [
      { ...validFinding, evidence: { network: 'POST /api/translations -> 4 senses' } },
    ],
  };
  const parsed = parseReport(sparse);
  assert.deepEqual(parsed.findings[0].evidence.screenshots, []);
  assert.deepEqual(parsed.findings[0].evidence.console, []);
  assert.equal(parsed.notes, '');
});
