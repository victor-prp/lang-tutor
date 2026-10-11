import { isLastDayOfWeek, liveDimensions, weekNumbers, weekOf } from './analysis.ts';
import type { DayDone } from './driver.ts';
import { closingComment, dailyComment, issueBody, type IssueSink } from './issue.ts';
import type { BotMemory } from './memory.ts';
import { dateOf, memoryFor } from './play.ts';
import { reportPrompt, weekSummary, type Reporter } from './report.ts';
import type { Profile } from './roster.ts';
import type { BotState, StateStore } from './state.ts';

/**
 * Spec D20–D22, after each simulated day of a run: the week's issue gets the day's lines, and
 * the run that finishes the week's last day for every bot closes it. Closing computes the five
 * numbers and asks for one report per bot, keeps both in the bot's state (committed), then posts
 * the closing comment and closes the issue. A bot's numbers and report are made once: a closing
 * that dies half-way is finished by the next run without paying twice, and a closed issue is
 * never closed again.
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

export function weeklyIssue(deps: WeekDeps): (done: DayDone) => Promise<void> {
  return async ({ day, states, played }) => {
    const week = weekOf(day);
    const ref = await deps.sink.open(week, issueBody(deps.profiles));
    if (played.length > 0) await deps.sink.comment(ref, dailyComment(day, played));

    const finished = deps.profiles.every((p) => (states.get(p.name)?.day ?? 0) >= day);
    if (!isLastDayOfWeek(day) || !finished || ref.closed) return;

    for (const profile of deps.profiles) {
      const state = states.get(profile.name)!;
      const memory = memoryAtEndOf(profile, state, day);
      const live = liveDimensions(profile.devices);
      if (!state.weeks?.some((w) => w.week === week)) {
        state.weeks = [...(state.weeks ?? []), weekNumbers(state, week, memory, live)];
      }
      if (!state.reports?.some((r) => r.week === week)) {
        const record = await deps.reporter.write(profile.name, week, reportPrompt(profile, weekSummary(state, week, memory)));
        if (record.error) deps.log(`${profile.name}: no report for week ${week}: ${record.error}`);
        state.reports = [...(state.reports ?? []), record];
      }
      await deps.store.save(state, `${profile.name}: week ${week} closed`);
    }

    const bots = deps.profiles.map((p) => {
      const state = states.get(p.name)!;
      return { name: p.name, weeks: state.weeks ?? [], reports: state.reports ?? [] };
    });
    await deps.sink.comment(ref, closingComment(week, bots));
    await deps.sink.close(ref);
    deps.log(`week ${week} closed: ${deps.sink.where(ref)}`);
  };
}
