import { z } from 'zod';

/**
 * The shape the agent writes to .out/findings.json.
 *
 * The one rule encoded here rather than left to the brief is the rules of
 * evidence: a finding must carry at least one of a screenshot, a network
 * exchange or a console error. A report is a claim about the product, and a
 * claim with nothing behind it is the failure mode this whole run exists to
 * avoid. The brief says the same thing in prose; this is what makes it true.
 *
 * `match` is deliberately absent. Deduplication is phase B, and adding the
 * field before there is anything to match against would invite the agent to
 * invent issue numbers.
 */

export const severities = ['bug', 'weird', 'inconvenience'] as const;
export const confidences = ['high', 'medium', 'low'] as const;

const evidenceSchema = z.object({
  screenshots: z.array(z.string()).default([]),
  network: z.string().optional(),
  console: z.array(z.string()).default([]),
});

const findingSchema = z
  .object({
    id: z.string().min(1),
    severity: z.enum(severities),
    confidence: z.enum(confidences),
    title: z.string().min(1),
    screen: z.string().min(1),
    steps: z.array(z.string().min(1)).min(1),
    expected: z.string().min(1),
    observed: z.string().min(1),
    evidence: evidenceSchema,
    fingerprint: z.string().min(1),
  })
  .refine(
    (f) =>
      f.evidence.screenshots.length > 0 ||
      f.evidence.console.length > 0 ||
      (f.evidence.network?.trim().length ?? 0) > 0,
    { message: 'a finding needs evidence: a screenshot, a network exchange or a console error' },
  );

/** The report minus its findings, which parseReportLoose validates one by one. */
const envelopeSchema = z.object({
  run: z.object({
    date: z.string().min(1),
    persona: z.string().min(1),
    focus: z.string().min(1),
    browser_ok: z.boolean(),
  }),
  coverage: z.array(z.string()),
  findings: z.array(z.unknown()),
  notes: z.string().default(''),
});

export const reportSchema = z.object({
  run: z.object({
    date: z.string().min(1),
    persona: z.string().min(1),
    focus: z.string().min(1),
    browser_ok: z.boolean(),
  }),
  coverage: z.array(z.string()),
  findings: z.array(findingSchema),
  notes: z.string().default(''),
});

export type Severity = (typeof severities)[number];
export type Finding = z.infer<typeof findingSchema>;
export type QaReport = z.infer<typeof reportSchema>;

export function parseReport(value: unknown): QaReport {
  return reportSchema.parse(value);
}

/**
 * The envelope strictly, the findings one at a time.
 *
 * A single unevidenced finding used to reject the entire report, which threw
 * away a whole session - five sound findings among them - over one weak sixth.
 * That is the wrong trade: the contract exists to keep unevidenced claims from
 * being filed, not to punish the run that carried one. So a bad finding is
 * dropped and named, and the rest survive.
 *
 * The envelope still throws, because a broken envelope means the session did
 * not produce a report at all, and there is nothing to salvage.
 */
export type DroppedFinding = { id: string; reason: string };

export function parseReportLoose(value: unknown): {
  report: QaReport;
  dropped: DroppedFinding[];
} {
  const envelope = envelopeSchema.parse(value);
  const findings: Finding[] = [];
  const dropped: DroppedFinding[] = [];

  envelope.findings.forEach((candidate, index) => {
    const result = findingSchema.safeParse(candidate);
    if (result.success) {
      findings.push(result.data);
      return;
    }
    const id =
      candidate && typeof candidate === 'object' && typeof (candidate as { id?: unknown }).id === 'string'
        ? ((candidate as { id: string }).id)
        : `#${index}`;
    dropped.push({ id, reason: result.error.issues.map((i) => i.message).join('; ') });
  });

  return { report: { ...envelope, findings }, dropped };
}

/**
 * A referenced screenshot is not the same thing as a screenshot.
 *
 * The evidence rule is satisfied by a filename, and a filename is something the
 * model writes rather than something the browser produced. In the first two
 * sessions the screenshot tool silently wrote nothing whenever it was handed a
 * path with a directory in it, while still reporting success, so two findings
 * cited images that never existed. Nothing downstream could tell.
 *
 * `exists` is injected so this stays pure and testable; the caller supplies the
 * filesystem. `unevidenced` names findings whose ONLY evidence was an image
 * that is not there, which is the case that matters: everything else still has
 * a network exchange or a console error behind it.
 */
export function checkScreenshots(
  report: QaReport,
  exists: (relativePath: string) => boolean,
): { missing: { id: string; path: string }[]; unevidenced: string[] } {
  const missing: { id: string; path: string }[] = [];
  const unevidenced: string[] = [];

  for (const finding of report.findings) {
    const present = finding.evidence.screenshots.filter((path) => {
      if (exists(path)) return true;
      missing.push({ id: finding.id, path });
      return false;
    });

    const hasOther =
      finding.evidence.console.length > 0 ||
      (finding.evidence.network?.trim().length ?? 0) > 0;
    if (present.length === 0 && !hasOther) unevidenced.push(finding.id);
  }

  return { missing, unevidenced };
}
