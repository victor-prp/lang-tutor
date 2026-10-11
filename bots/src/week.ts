import { DAYS_PER_WEEK, liveDimensions, weekNumbers, weekOf } from './analysis.ts';
import type { DayDone, DayNext } from './driver.ts';
import { closingComment, dailyComment, issueBody, type IssueSink } from './issue.ts';
import type { BotMemory } from './memory.ts';
import { dateOf, memoryFor } from './play.ts';
import { ReportLimitError, reportPrompt, weekSummary, type Reporter } from './report.ts';
import type { Profile } from './roster.ts';
import type { BotState, StateStore } from './state.ts';

/**
 * Spec D20–D22. After each simulated day of a run, the week's issue gets the day's lines. A week
 * is closed once every bot has finished its last day: the five numbers and one report per bot are
 * made and kept in the bot's state (committed), then the closing comment is posted and the issue
 * closed.
 *
 * Closing is tried twice over: after the day that finishes the week, and again before every
 * later day is played. So a run that dies mid-close (a `gh` error, the job's timeout) is finished
 * by the next run, before it plays a day, while every bot's memory is still the week's end
 * memory. A week found unclosed after later days were played is closed all the same, with (e)
 * left out, since the memory at its end is gone. A bot's numbers and report are made once, so a
 * finished close never pays twice, and a closed issue is never closed again. When the run's report
 * calls run out (MAX_REPORTS_PER_RUN), the rest waits for the next run.
 */
export type WeekDeps = {
  profiles: readonly Profile[];
  store: StateStore;
  sink: IssueSink;
  reporter: Reporter;
  log: (line: string) => void;
};

/** The bot's hidden memory at the end of `day`, on a copy: analysis must not change the state. */
function memoryAtEndOf(profile: Profile, state: BotState, day: number): BotMemory {
  const memory = memoryFor(profile, { ...state, memory: structuredClone(state.memory) });
  memory.setTime({ day: dateOf(day + 1), hour: (day + 1) * 24 });
  return memory;
}

export function weeklyIssue(deps: WeekDeps): {
  beforeDay: (next: DayNext) => Promise<void>;
  afterDay: (done: DayDone) => Promise<void>;
} {
  const stateOf = (states: ReadonlyMap<string, BotState>, name: string) => {
    const state = states.get(name);
    if (!state) throw new Error(`no state for ${name}`);
    return state;
  };

  /** Weeks this run found or left closed: not looked up again. */
  const closed = new Set<number>();

  /** Week `week`'s numbers and reports, then its closing comment. False when the run's report
   *  calls ran out first: the week stays open for the next run. */
  async function closeWeek(week: number, states: ReadonlyMap<string, BotState>, finished: number, late: boolean): Promise<boolean> {
    if (closed.has(week)) return true;
    const ref = await deps.sink.open(week, issueBody(deps.profiles));
    if (ref.closed) {
      closed.add(week);
      return true;
    }
    const lastDay = week * DAYS_PER_WEEK;
    // The memory is the week's end memory only while no bot has played past the week.
    const exact = finished === lastDay;
    // Every bot's numbers first, while the memory is the week's: a run whose report calls run
    // out part-way still leaves them exact.
    for (const profile of deps.profiles) {
      const state = stateOf(states, profile.name);
      if (state.weeks?.some((w) => w.week === week)) continue;
      const numbers = weekNumbers(state, week, memoryAtEndOf(profile, state, lastDay), liveDimensions(profile.devices));
      state.weeks = [...(state.weeks ?? []), exact ? numbers : { ...numbers, e: null, late: true }];
      await deps.store.save(state, `${profile.name}: week ${week} numbers`);
    }
    for (const profile of deps.profiles) {
      const state = stateOf(states, profile.name);
      if (state.reports?.some((r) => r.week === week)) continue;
      const summary = weekSummary(state, week, memoryAtEndOf(profile, state, lastDay));
      let record;
      try {
        record = await deps.reporter.write(profile.name, week, reportPrompt(profile, summary));
      } catch (error) {
        if (!(error instanceof ReportLimitError)) throw error;
        deps.log(`week ${week}: ${error.message}; the next run finishes closing it`);
        return false;
      }
      if (record.error) deps.log(`${profile.name}: no report for week ${week}: ${record.error}`);
      state.reports = [...(state.reports ?? []), record];
      await deps.store.save(state, `${profile.name}: week ${week} report`);
    }
    const bots = deps.profiles.map((p) => {
      const state = stateOf(states, p.name);
      return { name: p.name, weeks: state.weeks ?? [], reports: state.reports ?? [] };
    });
    await deps.sink.comment(ref, closingComment(week, bots, { late }));
    await deps.sink.close(ref);
    closed.add(week);
    deps.log(`week ${week} closed${late ? ' late' : ''}: ${deps.sink.where(ref)}`);
    return true;
  }

  /**
   * Every finished week that is not closed yet, oldest first. A week needs closing when a bot
   * lacks its numbers or its report, or, for the latest finished week, when its issue is open:
   * the numbers can be made and the comment still fail.
   */
  async function closeFinished(states: ReadonlyMap<string, BotState>, late: boolean): Promise<void> {
    const finished = Math.min(...deps.profiles.map((p) => stateOf(states, p.name).day));
    const latest = Math.floor(finished / DAYS_PER_WEEK);
    for (let week = 1; week <= latest; week++) {
      const missing = deps.profiles.some((p) => {
        const s = stateOf(states, p.name);
        return !s.weeks?.some((w) => w.week === week) || !s.reports?.some((r) => r.week === week);
      });
      if (!missing && week !== latest) continue;
      if (!(await closeWeek(week, states, finished, late || finished > week * DAYS_PER_WEEK))) return;
    }
  }

  return {
    async beforeDay({ states }) {
      await closeFinished(states, true);
    },
    async afterDay({ day, states, played }) {
      // A daily comment that fails must not keep the week from closing: the error is raised
      // after the close has been tried.
      let failure: unknown;
      if (played.length > 0) {
        try {
          const ref = await deps.sink.open(weekOf(day), issueBody(deps.profiles));
          await deps.sink.comment(ref, dailyComment(day, played));
        } catch (error) {
          deps.log(`day ${day}: the daily comment failed: ${error instanceof Error ? error.message : String(error)}`);
          failure = error;
        }
      }
      await closeFinished(states, false);
      if (failure) throw failure;
    },
  };
}
