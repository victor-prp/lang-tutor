import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { QuestionType } from '@lang-tutor/core/domain';

import { DAYS_PER_WEEK } from './analysis.ts';
import type { BotMemory } from './memory.ts';
import type { Profile } from './roster.ts';
import type { BotState } from './state.ts';

/**
 * Spec D20. At the end of each simulated week, one Claude CLI call per bot on Victor's
 * subscription: the bot's profile and its week, and a short report in its voice on how the
 * sessions felt. From the CLI's JSON the state keeps `total_cost_usd` and the token counts,
 * tagged with the bot, the week and the workflow run. At most MAX_REPORTS_PER_RUN calls a run,
 * in code, so a bug cannot loop on the subscription.
 */

/** One per bot in the roster: a week's reports, and no more. */
export const MAX_REPORTS_PER_RUN = 6;

/** Runs the CLI with these arguments and gives back its stdout; rejects on a non-zero exit. */
export type CommandRunner = (args: readonly string[]) => Promise<string>;

/** A command run with its arguments as an array, never through a shell. */
export function commandRunner(command: string, opts: { cwd?: string; timeoutMs?: number } = {}): CommandRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        command,
        [...args],
        { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout, stderr) => {
          if (error) reject(new Error(`${command} failed: ${error.message}${stderr ? `\n${stderr.trim()}` : ''}`));
          else resolve(stdout);
        },
      );
    });
}

/**
 * The real `claude`, run in an empty directory of its own: no repository CLAUDE.md, settings or
 * hooks reach the call, which has no tools anyway. Authenticates by CLAUDE_CODE_OAUTH_TOKEN.
 */
export function claudeRunner(): CommandRunner {
  return commandRunner('claude', { cwd: mkdtempSync(join(tmpdir(), 'bots-report-')), timeoutMs: 5 * 60_000 });
}

/** D20: Sonnet, no tools, three turns at most, JSON out. */
export function reportArgs(prompt: string): string[] {
  return ['-p', prompt, '--model', 'sonnet', '--max-turns', '3', '--output-format', 'json', '--tools', ''];
}

export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };

export type ReportRecord = {
  bot: string;
  /** The simulated week reported on. */
  week: number;
  /** The workflow run that made the call (GITHUB_RUN_ID), or `local`. */
  runId: string;
  text: string;
  costUsd: number;
  usage: Usage;
  /** Why there is no report, when there is none. */
  error?: string;
};

const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

/**
 * The result object of `claude -p --output-format json`, as nightly-qa's summarize.ts reads the
 * same object from its stream: `result`, `total_cost_usd`, `usage`, `is_error`, `subtype`.
 */
export function parseCliJson(stdout: string): { text: string; costUsd: number; usage: Usage; isError: boolean; subtype: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`not the CLI's JSON: ${stdout.trim().slice(0, 200)}`);
  }
  // Some CLI versions print the whole event list; the result is its last event of that type.
  const result = (Array.isArray(parsed) ? parsed.filter((e) => e?.type === 'result').at(-1) : parsed) as Record<string, unknown> | undefined;
  if (!result || typeof result !== 'object') throw new Error(`not the CLI's JSON: no result event`);
  if (typeof result.total_cost_usd !== 'number') throw new Error(`the CLI's JSON has no total_cost_usd`);
  const usage = (result.usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  return {
    text: typeof result.result === 'string' ? result.result.trim() : '',
    costUsd: result.total_cost_usd,
    usage: {
      inputTokens: n(usage.input_tokens),
      outputTokens: n(usage.output_tokens),
      cacheReadTokens: n(usage.cache_read_input_tokens),
      cacheCreationTokens: n(usage.cache_creation_input_tokens),
    },
    isError: result.is_error === true,
    subtype: typeof result.subtype === 'string' ? result.subtype : 'unknown',
  };
}

export class ReportLimitError extends Error {
  constructor(limit: number) {
    super(`refused: a run makes at most ${limit} report calls`);
    this.name = 'ReportLimitError';
  }
}

export interface Reporter {
  /** One report. A failed call is a record with an error; only the limit throws. */
  write(bot: string, week: number, prompt: string): Promise<ReportRecord>;
}

export function createReporter(opts: { run: CommandRunner; runId: string; limit?: number }): Reporter {
  const limit = opts.limit ?? MAX_REPORTS_PER_RUN;
  let calls = 0;
  return {
    async write(bot, week, prompt) {
      // Counted before the call, so a call that fails still uses its place.
      if (calls >= limit) throw new ReportLimitError(limit);
      calls += 1;
      const base = { bot, week, runId: opts.runId };
      let stdout: string;
      try {
        stdout = await opts.run(reportArgs(prompt));
      } catch (error) {
        return { ...base, text: '', costUsd: 0, usage: NO_USAGE, error: error instanceof Error ? error.message : String(error) };
      }
      try {
        const parsed = parseCliJson(stdout);
        return {
          ...base,
          text: parsed.text,
          costUsd: parsed.costUsd,
          usage: parsed.usage,
          ...(parsed.isError || parsed.text === '' ? { error: `the CLI ended with ${parsed.subtype}` } : {}),
        };
      } catch (error) {
        return { ...base, text: '', costUsd: 0, usage: NO_USAGE, error: (error as Error).message };
      }
    },
  };
}

/** Spec §6: a dry run makes no Claude call. */
export function dryReporter(runId: string): Reporter {
  return {
    write: async (bot, week) => ({ bot, week, runId, text: '(dry run: no Claude call)', costUsd: 0, usage: NO_USAGE }),
  };
}

/** A word asked this many times in one session is "the same word again". */
export const REPEAT_TIMES = 3;
/** Below this true recall at the end of the week, a word not asked all week is "forgotten". */
export const FORGOTTEN_P = 0.5;

export type WeekSummary = {
  week: number;
  daysPlayed: number;
  sessions: number;
  cards: number;
  right: number;
  newWords: number;
  unheard: number;
  unmatched: number;
  byType: Partial<Record<QuestionType, { cards: number; right: number }>>;
  /** Words met again on a later day, each with its longest absence in days, longest first. */
  cameBack: { word: string; afterDays: number }[];
  /** Words asked REPEAT_TIMES or more in one session, most first. */
  repeated: { word: string; times: number }[];
  /** Saved words the bot no longer recalls (written receptive) that no card asked this week. */
  forgotten: string[];
};

const LIST_CAP = 12;

/** D20's summary of a week. `memory` is the bot's hidden memory at the end of the week. */
export function weekSummary(state: BotState, week: number, memory: BotMemory): WeekSummary {
  const first = (week - 1) * DAYS_PER_WEEK + 1;
  const last = week * DAYS_PER_WEEK;
  const inWeek = (day: number) => day >= first && day <= last;
  const days = state.days.filter((d) => inWeek(d.day));
  const cards = state.log.filter((c) => inWeek(c.day));

  const byType: WeekSummary['byType'] = {};
  for (const c of cards) {
    const t = (byType[c.type] ??= { cards: 0, right: 0 });
    t.cards += 1;
    if (c.correct) t.right += 1;
  }

  // The last day each word was asked, walking the whole log in order.
  const lastAsked = new Map<string, number>();
  const cameBack: WeekSummary['cameBack'] = [];
  for (const c of state.log) {
    if (c.word === null) continue;
    const before = lastAsked.get(c.word);
    if (before !== undefined && c.day > before && inWeek(c.day)) cameBack.push({ word: c.word, afterDays: c.day - before });
    lastAsked.set(c.word, c.day);
  }
  cameBack.sort((a, b) => b.afterDays - a.afterDays);
  // Each word once, at its longest absence.
  const longest = cameBack.filter((c, i) => cameBack.findIndex((o) => o.word === c.word) === i);

  const perSession = new Map<string, number>();
  for (const c of cards) if (c.word !== null) perSession.set(`${c.session}\u0000${c.word}`, (perSession.get(`${c.session}\u0000${c.word}`) ?? 0) + 1);
  const repeated = [...perSession]
    .filter(([, times]) => times >= REPEAT_TIMES)
    .map(([k, times]) => ({ word: k.split('\u0000')[1], times }))
    .sort((a, b) => b.times - a.times);

  const askedThisWeek = new Set(cards.map((c) => c.word));
  const forgotten = state.saved
    .filter((w) => w.day <= last && !askedThisWeek.has(w.form) && memory.recall(w.form, 'written_receptive') < FORGOTTEN_P)
    .map((w) => w.form);

  const sum = (pick: (d: (typeof days)[number]) => number | undefined) => days.reduce((s, d) => s + (pick(d) ?? 0), 0);
  return {
    week,
    daysPlayed: days.filter((d) => d.played).length,
    sessions: sum((d) => d.sessions),
    cards: cards.length,
    right: cards.filter((c) => c.correct).length,
    newWords: sum((d) => d.newWords),
    unheard: sum((d) => d.unheard),
    unmatched: sum((d) => d.unmatched),
    byType,
    cameBack: longest.slice(0, LIST_CAP),
    repeated: repeated.slice(0, LIST_CAP),
    forgotten: forgotten.slice(0, LIST_CAP),
  };
}

const LANGUAGE_NAMES = { en: 'English', ru: 'Russian', it: 'Italian' } as const;

/** D20's prompt: the profile, the week, and what to write. */
export function reportPrompt(profile: Profile, s: WeekSummary): string {
  const devices = [profile.devices.listening ? 'can listen' : 'cannot listen', profile.devices.speaking ? 'can speak' : 'cannot speak'];
  const memory =
    profile.memory === 'fsrs'
      ? 'you forget exactly the way the app assumes'
      : `your forgetting has decay ${profile.actr?.a} and threshold ${profile.actr?.tau}`;
  const types = Object.entries(s.byType)
    .map(([type, t]) => `${type.replaceAll('_', ' ')} ${t.right}/${t.cards}`)
    .join(', ');
  const list = <T>(items: T[], show: (t: T) => string) => (items.length === 0 ? 'none' : items.map(show).join(', '));
  return [
    `You are ${profile.name}, a simulated learner practising ${LANGUAGE_NAMES[profile.language]} vocabulary from Hebrew in a`,
    `language-learning app. Your profile: ${profile.sessions[0]}-${profile.sessions[1]} sessions a day, you play on`,
    `${Math.round(profile.playChance * 100)}% of days, you save ${profile.lookups[0]}-${profile.lookups[1]} new words a day, you ${devices.join(' and ')}; ${memory}.`,
    '',
    `Your simulated week ${s.week}:`,
    `- ${s.daysPlayed} days played, ${s.sessions} sessions, ${s.cards} cards, ${s.right} right, ${s.newWords} new words saved.`,
    `- By card type (right/asked): ${types || 'none'}.`,
    `- Words that came back on a later day: ${list(s.cameBack, (c) => `${c.word} after ${c.afterDays} days`)}.`,
    `- The same word again in one session: ${list(s.repeated, (r) => `${r.word} ${r.times} times`)}.`,
    `- Words you have forgotten that no card asked this week: ${list(s.forgotten, (w) => w)}.`,
    `- Spoken answers the app did not hear: ${s.unheard} unheard. Cards you could not match to a saved word: ${s.unmatched} unmatched.`,
    '',
    'Write a short report, at most 150 words, in the first person and in your voice, on how this week\'s',
    'sessions felt: too easy or too hard, the same word again and again, words you had forgotten that never',
    'came back. Plain text, no headings, and no numbers that are not given above.',
  ].join('\n');
}
