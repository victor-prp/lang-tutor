import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkScreenshots, parseReport, parseReportLoose } from './findings.ts';

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

test('parseReportLoose keeps the good findings and drops the unevidenced one', () => {
  const mixed = {
    ...validReport,
    findings: [
      validFinding,
      { ...validFinding, id: 'f2', evidence: { screenshots: [], console: [] } },
      { ...validFinding, id: 'f3' },
    ],
  };
  const { report, dropped } = parseReportLoose(mixed);
  assert.equal(report.findings.length, 2);
  assert.deepEqual(
    report.findings.map((f) => f.id),
    ['f1', 'f3'],
  );
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].id, 'f2');
  assert.match(dropped[0].reason, /evidence/);
});

test('parseReportLoose still throws when the envelope itself is broken', () => {
  assert.throws(() => parseReportLoose({ findings: [] }));
  assert.throws(() => parseReportLoose({ ...validReport, run: { ...validReport.run, browser_ok: 'yes' } }));
});

test('parseReportLoose reports a dropped finding by index when it has no usable id', () => {
  const mixed = { ...validReport, findings: [{ nonsense: true }] };
  const { report, dropped } = parseReportLoose(mixed);
  assert.equal(report.findings.length, 0);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].id, '#0');
});

test('checkScreenshots names referenced screenshots that are not on disk', () => {
  const report = parseReport({
    ...validReport,
    findings: [
      { ...validFinding, id: 'f1', evidence: { screenshots: ['shots/real.png'], network: 'n', console: [] } },
      { ...validFinding, id: 'f2', evidence: { screenshots: ['shots/ghost.png'], network: 'n', console: [] } },
    ],
  });
  const { missing, unevidenced } = checkScreenshots(report, (p) => p === 'shots/real.png');
  assert.deepEqual(missing, [{ id: 'f2', path: 'shots/ghost.png' }]);
  assert.deepEqual(unevidenced, []);
});

test('checkScreenshots flags a finding whose only evidence was a screenshot that does not exist', () => {
  const report = parseReport({
    ...validReport,
    findings: [
      { ...validFinding, id: 'f1', evidence: { screenshots: ['shots/ghost.png'], console: [] } },
    ],
  });
  const { missing, unevidenced } = checkScreenshots(report, () => false);
  assert.equal(missing.length, 1);
  assert.deepEqual(unevidenced, ['f1']);
});

test('checkScreenshots is quiet when every screenshot exists', () => {
  const report = parseReport(validReport);
  const { missing, unevidenced } = checkScreenshots(report, () => true);
  assert.deepEqual(missing, []);
  assert.deepEqual(unevidenced, []);
});
