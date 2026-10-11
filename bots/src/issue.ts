import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { WeekNumbers } from './analysis.ts';
import { dateOf } from './play.ts';
import type { CommandRunner, ReportRecord } from './report.ts';
import type { Profile } from './roster.ts';
import type { DayLine } from './state.ts';

/**
 * Spec D22. The weekly issue: "Bots — simulated week N", label `bots`, opened by the first run
 * of the week, a comment per run with a line per bot, and a closing comment from the week's last
 * run with the five numbers, the reports and the Claude spend. Written through the GitHub CLI
 * with the workflow's token; a dry run writes the same text to a file instead (spec §6).
 */

export const LABEL = 'bots';
const LABEL_COLOR = '0e8a16';
const LABEL_DESCRIPTION = 'Weekly reports of the simulated learners';
/** GitHub refuses a comment over 65,536 characters; six reports stay well under it at this. */
const REPORT_CHARS = 4_000;

export const issueTitle = (week: number) => `Bots — simulated week ${week}`;

const LANGUAGE_NAMES = { en: 'English', ru: 'Russian', it: 'Italian' } as const;

const range = ([lo, hi]: readonly [number, number]) => (lo === hi ? `${lo}` : `${lo}–${hi}`);
const plays = (chance: number) => (chance >= 1 ? 'every day' : chance === 2 / 3 ? '2 days in 3' : `${Math.round(chance * 100)}% of days`);

/** The issue's body: the roster (D13), and what the comments will hold. */
export function issueBody(profiles: readonly Profile[]): string {
  return [
    'The simulated learners play one simulated day per hourly run against production (phase 35, spec D18–D22).',
    'Each run adds a comment with a line per bot; the week\'s last run adds the five numbers, the bots\' reports and the Claude spend, and closes the issue.',
    '',
    '| Bot | Memory | Language | Sessions a day | Plays | Devices |',
    '|---|---|---|---|---|---|',
    ...profiles.map((p) => {
      const devices = [p.devices.listening && 'listening', p.devices.speaking && 'speaking'].filter(Boolean).join(', ') || 'none';
      return `| ${p.name} | ${p.memory === 'fsrs' ? 'FSRS-6' : 'ACT-R'} | ${LANGUAGE_NAMES[p.language]} | ${range(p.sessions)} | ${plays(p.playChance)} | ${devices} |`;
    }),
    '',
    'How to read, stop or reset them: `docs/runbooks/bots.md`.',
    '',
  ].join('\n');
}

/** D22: one comment per run, a line per bot it played. */
export function dailyComment(day: number, lines: readonly { name: string; line: DayLine }[]): string {
  const row = ({ name, line }: { name: string; line: DayLine }) => {
    if (!line.played && line.completed) return `| ${name} | rested | | | | | | | |`;
    const share = line.cards > 0 ? Math.round((100 * line.right) / line.cards) : 0;
    const failed = line.completed ? `${line.failed}` : `${line.failed}, day not finished`;
    return `| ${name} | ${line.sessions} | ${line.cards} | ${line.right} (${share}%) | ${line.newWords} | ${line.unheard} | ${line.noVoice} | ${line.unmatched} | ${failed} |`;
  };
  return [
    `**Day ${day}** (${dateOf(day)})`,
    '',
    '| Bot | Sessions | Cards | Right | New words | Unheard | No voice | Unmatched | Failed requests |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...lines.map(row),
    '',
  ].join('\n');
}

const fixed = (v: number | null) => (v === null ? '–' : v.toFixed(2));
const days = (v: number | null) => (v === null ? '–' : `${Math.round(v * 10) / 10}`);
const usd = (v: number) => `$${v.toFixed(4)}`;

export type ClosingBot = { name: string; weeks: readonly WeekNumbers[]; reports: readonly ReportRecord[] };

/** D22's closing comment for `week`: the numbers against every earlier week, the reports, the spend. */
export function closingComment(week: number, bots: readonly ClosingBot[], opts: { late?: boolean } = {}): string {
  const out = [`## Week ${week} closed`, ''];
  if (opts.late) {
    out.push(
      "_Closed by a later run: the week's last run did not finish closing it. A (e) of – is a week closed after later days were played, when the memory at its end was gone._",
      '',
    );
  }
  out.push(
    '### The five numbers',
    '',
    "(a) weak words' share of cards over their share of the list: above 1 is the aim. (b) cards testing a word's weakest dimension. (c) median days between reviews right in a row, 2nd / 3rd / 4th+: rising is the aim. (d) cards off the rung that level and R imply: low is the aim. (e) mean true recall at the week's end: steady or rising is the aim.",
    '',
    '| Bot | Week | Cards | a | b | c | d | e |',
    '|---|---:|---:|---:|---:|---|---:|---:|',
  );
  for (const bot of bots) {
    for (const n of [...bot.weeks].filter((n) => n.week <= week).sort((x, y) => x.week - y.week)) {
      out.push(
        `| ${bot.name} | ${n.week} | ${n.cards} | ${fixed(n.a)} | ${fixed(n.b)} | ${days(n.c.second)} / ${days(n.c.third)} / ${days(n.c.later)} | ${fixed(n.d)} | ${fixed(n.e)} |`,
      );
    }
  }

  out.push('', '### Reports', '');
  const thisWeek = (bot: ClosingBot) => bot.reports.filter((r) => r.week === week);
  for (const bot of bots) {
    const record = thisWeek(bot).at(-1);
    out.push(`**${bot.name}**`, '');
    if (!record) out.push('_No report._');
    else if (record.error) out.push(`_No report: ${record.error.split('\n')[0]}_`);
    else {
      const text = record.text.length > REPORT_CHARS ? `${record.text.slice(0, REPORT_CHARS)}…` : record.text;
      out.push(...text.split('\n').map((l) => (l === '' ? '>' : `> ${l}`)));
    }
    out.push('');
  }

  out.push('### Claude spend', '', '| Bot | This week | Input | Output | Cache read | Cache write |', '|---|---:|---:|---:|---:|---:|');
  let total = 0;
  for (const bot of bots) {
    const records = thisWeek(bot);
    const sum = (pick: (r: ReportRecord) => number) => records.reduce((s, r) => s + pick(r), 0);
    const cost = sum((r) => r.costUsd);
    total += cost;
    out.push(
      `| ${bot.name} | ${usd(cost)} | ${sum((r) => r.usage.inputTokens)} | ${sum((r) => r.usage.outputTokens)} | ${sum((r) => r.usage.cacheReadTokens)} | ${sum((r) => r.usage.cacheCreationTokens)} |`,
    );
  }
  const upToNow = bots.flatMap((b) => b.reports.filter((r) => r.week <= week));
  const running = upToNow.reduce((s, r) => s + r.costUsd, 0);
  out.push(`| **Total** | **${usd(total)}** | | | | |`, '', `Running total since day 1: ${usd(running)} over ${upToNow.length} report calls.`, '');
  return out.join('\n');
}

/** Where a week's issue is: its number on GitHub, or null in a dry run's file. */
export type IssueRef = { week: number; number: number | null; closed: boolean };

export interface IssueSink {
  /** The week's issue, created with `body` when there is none. */
  open(week: number, body: string): Promise<IssueRef>;
  comment(ref: IssueRef, body: string): Promise<void>;
  close(ref: IssueRef): Promise<void>;
  /** Where to read it, for the run's log. */
  where(ref: IssueRef): string;
}

/** The real tracker, through `gh`. GH_TOKEN and GH_REPO come from the workflow. */
export function ghSink(gh: CommandRunner): IssueSink {
  return {
    async open(week, body) {
      const title = issueTitle(week);
      // Search narrows; the exact title decides ("week 3" also matches "week 30").
      const found = JSON.parse(
        await gh(['issue', 'list', '--label', LABEL, '--state', 'all', '--search', `"simulated week ${week}" in:title`, '--json', 'number,title,state', '--limit', '50']),
      ) as { number: number; title: string; state: string }[];
      const mine = found.find((i) => i.title === title);
      if (mine) return { week, number: mine.number, closed: mine.state.toUpperCase() === 'CLOSED' };
      await gh(['label', 'create', LABEL, '--color', LABEL_COLOR, '--description', LABEL_DESCRIPTION, '--force']);
      const url = (await gh(['issue', 'create', '--title', title, '--label', LABEL, '--body', body])).trim();
      const number = Number(url.split('/').at(-1));
      if (!Number.isInteger(number)) throw new Error(`gh issue create gave no issue URL: ${url}`);
      return { week, number, closed: false };
    },
    async comment(ref, body) {
      await gh(['issue', 'comment', String(ref.number), '--body', body]);
    },
    async close(ref) {
      await gh(['issue', 'close', String(ref.number)]);
    },
    where: (ref) => `issue #${ref.number}`,
  };
}

const CLOSED = '<!-- closed -->';

/** A dry run's issue: `week-N.md` in `dir`, the comments appended in order (spec §6). */
export function fileSink(dir: string): IssueSink {
  const file = (week: number) => join(dir, `week-${week}.md`);
  const append = (week: number, text: string) => appendFileSync(file(week), `\n---\n\n${text}\n`);
  return {
    async open(week, body) {
      mkdirSync(dir, { recursive: true });
      if (!existsSync(file(week))) writeFileSync(file(week), `# ${issueTitle(week)}\n\nLabel: ${LABEL}\n\n${body}\n`);
      return { week, number: null, closed: readFileSync(file(week), 'utf8').includes(CLOSED) };
    },
    async comment(ref, body) {
      append(ref.week, body);
    },
    async close(ref) {
      append(ref.week, CLOSED);
    },
    where: (ref) => file(ref.week),
  };
}
