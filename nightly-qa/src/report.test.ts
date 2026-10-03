import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Checked, TriageDecision } from './categories.ts';
import { renderReport, reportTitle, type ReportInput } from './report.ts';
import type { Change } from './triage.ts';

const d = (over: Partial<TriageDecision> = {}): TriageDecision => ({
  issue: 66, category: 'ux-polish', confidence: 'high', rationale: 'Works.', evidence: [], ...over,
});
const change = (over: Partial<TriageDecision> = {}, from: Change['from'] = null): Change => ({
  decision: d(over), from, to: d(over).category, action: 'labelled', commands: [],
});
const empty: Checked = { accepted: [], refused: [], undecided: [], ignored: [] };

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    date: '2026-10-04', runUrl: 'https://github.com/x/y/actions/runs/1',
    checked: empty, changes: [], ruleGaps: [], carried: [], failures: new Map(), titles: new Map([[66, 'Swap drops senses']]),
    ...over,
  };
}

test('the title carries the date', () => {
  assert.equal(reportTitle('2026-10-04'), '[nightly-qa] Triage report 2026-10-04');
});

test('nothing to look at says so, at the top', () => {
  const body = renderReport(input({ changes: [change()] }));
  assert.match(body.split('## All decisions')[0], /Nothing needs your attention/);
});

test('low confidence, rule gaps, refusals and undecided all land under Needs your attention', () => {
  const body = renderReport(
    input({
      changes: [change({ confidence: 'low' })],
      ruleGaps: [{ issues: [55], description: '5xx on odd input', suggested_change: 'say rule 3' }],
      checked: {
        ...empty,
        refused: [{ decision: d({ issue: 70, category: 'duplicate' }), reason: 'duplicate needs duplicate_of' }],
        undecided: [71],
      },
    }),
  );
  const attention = body.split('## All decisions')[0];
  assert.match(attention, /#66 .*low confidence/);
  assert.match(attention, /#55.*5xx on odd input.*say rule 3/);
  assert.match(attention, /#70 .*duplicate needs duplicate_of/);
  assert.match(attention, /#71 .*undecided/);
});

test('a recategorisation shows old → new, and a pipe in a rationale cannot break the table', () => {
  const body = renderReport(input({ changes: [change({ category: 'real_bug', rationale: 'a | b\nc' }, 'ux-polish')] }));
  assert.match(body, /\| #66 \| ux-polish → real_bug \| labelled \| high \| a \\\| b c \|/);
});

test('carried-over targets and ignored decisions are listed, and the run is linked', () => {
  const body = renderReport(input({ carried: [80, 81], checked: { ...empty, ignored: [d({ issue: 99 })] } }));
  assert.match(body, /## Carried over[\s\S]*#80, #81/);
  assert.match(body, /## Ignored[\s\S]*#99/);
  assert.match(body, /\[The run\]\(https:\/\/github\.com\/x\/y\/actions\/runs\/1\)/);
});

// Final review I1: a gh failure mid-apply still reaches the owner.
test('a change that failed to apply is highlighted and marked failed in the table', () => {
  const body = renderReport(input({ changes: [change()], failures: new Map([[66, 'HTTP 502']]) }));
  assert.match(body.split('## All decisions')[0], /#66 .*failed to apply: HTTP 502/);
  assert.match(body, /\| #66 \| ux-polish \| FAILED: labelled \|/);
});
