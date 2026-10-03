import { categories, CLOSING, type Category, type TriageDecision } from './categories.ts';

/**
 * The owner's hand-made decisions, as data. Used twice: once to seed the
 * backlog, so those decisions are applied exactly as made, and once to grade a
 * calibration run that was not shown them.
 */

/** RFC 4180, which is all examples.csv uses. No dependency for 30 lines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

const COLUMNS = ['issue', 'title', 'qa_label', 'fingerprint', 'category', 'action', 'rationale'] as const;
export type ExampleRow = Record<(typeof COLUMNS)[number], string>;

export function parseExamples(text: string): ExampleRow[] {
  const [header = [], ...rows] = parseCsv(text);
  if (header.join(',') !== COLUMNS.join(',')) {
    throw new Error(`examples.csv header is "${header.join(',')}", expected "${COLUMNS.join(',')}"`);
  }
  return rows.map((cells, index) => {
    if (cells.length !== COLUMNS.length) {
      throw new Error(`examples.csv row ${index + 2} has ${cells.length} fields, expected ${COLUMNS.length}`);
    }
    return Object.fromEntries(COLUMNS.map((column, j) => [column, cells[j]])) as ExampleRow;
  });
}

const isCategory = (value: string): value is Category => (categories as readonly string[]).includes(value);

export function toSeedDecisions(rows: ExampleRow[]): TriageDecision[] {
  return rows
    .filter((row) => isCategory(row.category))
    .map((row) => {
      const issue = Number(row.issue);
      const category = row.category as Category;
      const decision: TriageDecision = {
        issue,
        category,
        confidence: 'high',
        rationale: row.rationale,
        evidence: ['decided by hand in the 2026-10-03 triage (nightly-qa/triage/examples.csv)'],
      };
      if (category === 'duplicate') {
        const match = row.action.match(/duplicate of #(\d+)/i);
        if (!match) throw new Error(`examples.csv: #${issue} is a duplicate with no "duplicate of #N" in its action`);
        decision.duplicate_of = Number(match[1]);
      }
      return decision;
    });
}

export type Comparison = {
  total: number;
  agreed: number;
  disagreements: { issue: number; expected: Category; got: Category }[];
  /** Closed by the model, left open by the owner. The one disagreement that is not cheap. */
  wrongCloses: number[];
  missing: number[];
};

export function compare(
  rows: ExampleRow[],
  decisions: TriageDecision[],
  exclude: ReadonlySet<number> = new Set(),
): Comparison {
  const got = new Map(decisions.map((d) => [d.issue, d.category]));
  const expected = toSeedDecisions(rows).filter((d) => !exclude.has(d.issue));
  const result: Comparison = { total: expected.length, agreed: 0, disagreements: [], wrongCloses: [], missing: [] };

  for (const want of expected) {
    const category = got.get(want.issue);
    if (category === undefined) {
      result.missing.push(want.issue);
    } else if (category === want.category) {
      result.agreed++;
    } else {
      result.disagreements.push({ issue: want.issue, expected: want.category, got: category });
      if (CLOSING.has(category) && !CLOSING.has(want.category)) result.wrongCloses.push(want.issue);
    }
  }
  return result;
}
