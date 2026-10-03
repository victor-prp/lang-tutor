import {
  categories,
  CATEGORY_LABEL,
  CATEGORY_LABELS,
  CLOSING,
  type Category,
  type TriageDecision,
} from './categories.ts';
import { withDuplicateOf, type KnownIssue } from './knownIssues.ts';
import { REPORT_LABEL } from './targets.ts';

/**
 * Every write the apply job makes, decided here and nowhere else. Pure: it
 * returns `gh` argument lists and apply.ts runs them, the same split as
 * filing.ts and file.ts.
 */

export type Change = {
  decision: TriageDecision;
  from: Category | null;
  to: Category;
  action: string;
  commands: string[][];
};

const issueRef = (e: string): string => (/^#\d+$/.test(e) ? e : `\`${e}\``);

export function triageComment(decision: TriageDecision, from: Category | null): string {
  const head =
    from && from !== decision.category
      ? `**Triage** — recategorised from \`${from}\` to \`${decision.category}\`.`
      : `**Triage** — \`${decision.category}\`.`;
  const duplicate = decision.category === 'duplicate' ? `\n\nDuplicate of #${decision.duplicate_of}.` : '';
  const evidence =
    decision.evidence.length > 0 ? `\n\n**Evidence:** ${decision.evidence.map(issueRef).join(', ')}` : '';
  const confidence =
    decision.confidence === 'low' ? "\n\n_Low confidence: highlighted in tonight's triage report._" : '';
  return `${head}${duplicate}\n\n${decision.rationale}${evidence}${confidence}`;
}

function actionFor(to: Category, from: Category | null, decision: TriageDecision): string {
  if (to === 'duplicate') return `closed as duplicate of #${decision.duplicate_of}`;
  if (to === 'working-as-intended') return 'closed as by-design';
  return from ? 'recategorised' : 'labelled';
}

export function planChanges(accepted: TriageDecision[], known: KnownIssue[]): Change[] {
  const byNumber = new Map(known.map((issue) => [issue.number, issue]));

  return accepted.map((decision) => {
    const issue = byNumber.get(decision.issue);
    // checkDecisions only accepts targets, and targets come from the tracker.
    if (!issue) throw new Error(`#${decision.issue} was accepted but is not in known.json`);

    const to = decision.category;
    // An issue already wearing the decided label is that category, whatever
    // stray triage label a human left beside it - otherwise categoryFromLabels'
    // table order would pick the stray one and call a repair a recategorisation.
    const from = issue.labels.includes(CATEGORY_LABEL[to]) ? to : issue.category;
    const wanted = CATEGORY_LABELS[to];
    // Every other category the issue still wears gives up all of its labels,
    // companions included - otherwise a stray triage:ux-polish leaves
    // known-issue behind on what is now a real bug, and the explorer skips it.
    const stray = issue.labels.filter((l) => l.startsWith('triage:') && l !== CATEGORY_LABEL[to]);
    const leaving = categories
      .filter((c) => c !== to && issue.labels.includes(CATEGORY_LABEL[c]))
      .flatMap((c) => CATEGORY_LABELS[c])
      .filter((l) => !wanted.includes(l) && issue.labels.includes(l));
    const remove = [...new Set([...stray, ...leaving])];
    const add = wanted.filter((l) => !issue.labels.includes(l));

    const n = String(decision.issue);
    const commands: string[][] = [];
    // Applied LAST. The triage label is what takes an issue out of tomorrow's
    // targets, so it must mean "everything before it landed": a comment or a
    // close that fails leaves the issue uncategorised, and it is tried again.
    const labelEdit =
      add.length > 0 || remove.length > 0
        ? [
            'issue', 'edit', n,
            ...add.flatMap((l) => ['--add-label', l]),
            ...remove.flatMap((l) => ['--remove-label', l]),
          ]
        : null;

    // Same category: say nothing. A sighting that changes no decision should
    // not cost the issue's watchers a notification.
    if (from === to) {
      if (labelEdit) commands.push(labelEdit);
      return { decision, from, to, action: commands.length > 0 ? 'labels repaired' : 'unchanged', commands };
    }

    if (to === 'duplicate' && decision.duplicate_of !== undefined) {
      commands.push(['issue', 'edit', n, '--body', withDuplicateOf(issue.body, decision.duplicate_of)]);
    }
    commands.push(['issue', 'comment', n, '--body', triageComment(decision, from)]);
    if (CLOSING.has(to)) commands.push(['issue', 'close', n, '--reason', 'not planned']);
    if (labelEdit) commands.push(labelEdit);

    return { decision, from, to, action: actionFor(to, from, decision), commands };
  });
}

/**
 * `--force` updates a label that exists instead of failing on it, so this is
 * safe every night. `duplicate` and `by-design` already exist and are left
 * alone: forcing them would overwrite a description a human chose.
 */
export function labelCommands(): string[][] {
  const create = (name: string, color: string, description: string) => [
    'label', 'create', name, '--color', color, '--description', description, '--force',
  ];
  return [
    ...categories.map((c) => create(CATEGORY_LABEL[c], '1d76db', `Triage category: ${c}`)),
    create('known-issue', 'bfdadc', 'Accepted; waiting for the real UI. The explorer deprioritises it.'),
    create(REPORT_LABEL, '5319e7', 'Nightly triage report'),
  ];
}
