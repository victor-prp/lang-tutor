import { ApiError, type BotApi, type BotRoute } from './api.ts';
import { dateOf, newLine, playDay, type Poll } from './play.ts';
import type { Profile } from './roster.ts';
import type { Synthesize } from './speech.ts';
import type { BotState, DayLine, StateStore } from './state.ts';

export { dateOf } from './play.ts';

/**
 * Spec D18, D19. A run plays `days` simulated days, one after another. Every bot shares one day
 * number: the day after the one the furthest-behind bot finished. For each bot not yet past it,
 * the run signs the bot in (D12), puts it on that day, plays the day, signs it out, and commits
 * its state before going on to the next bot (D17), so a run that dies keeps every bot it
 * finished.
 *
 * A failed request (ApiError) ends that bot's day: the failure is counted and logged, the bot
 * keeps its old day, and the run goes on with the next bot. What the bot did before the
 * failure is kept: the server has those answers too. The next run attempts the day again from
 * where this attempt stopped (play.ts: words already looked up and sessions already played are
 * not repeated), at most MAX_DAY_ATTEMPTS times in all, after which it is counted as done all
 * the same, so a bot that always fails cannot hold every other bot on one day. Anything else
 * thrown is a bug in the driver, and the run fails with it (D19), but only after the bot's state
 * is saved: the server has the crashed attempt's answers, so its cards, traces and saved words
 * must not be lost. The state is also saved after every session, for a run killed outright (the
 * job's timeout), which no `finally` sees.
 *
 * Each attempt has its own line in `state.days`, pushed as it starts and saved with every
 * checkpoint; the lines of a day's attempts add up to the day.
 */
export const MAX_DAY_ATTEMPTS = 3;

export type RunOptions = {
  profiles: readonly Profile[];
  days: number;
  route: BotRoute;
  apiFor: (cookie: string) => BotApi;
  store: StateStore;
  wordsFor: (profile: Profile) => readonly string[];
  synthesize: Synthesize;
  log: (line: string) => void;
  poll?: Poll;
  /** Before each simulated day is played, with every bot's state as the last day left it:
   *  closing a week its last run did not finish closing (D20–D22). */
  beforeDay?: (next: DayNext) => Promise<void>;
  /** After each simulated day, with every bot's state: the weekly issue and reports (D20–D22). */
  afterDay?: (done: DayDone) => Promise<void>;
  /** Once every day is played: fails the run for what the hooks let the days go on past. */
  afterRun?: () => Promise<void>;
};

/** The simulated day a run is about to play, and every bot's state before it. */
export type DayNext = { day: number; states: ReadonlyMap<string, BotState> };

/** A simulated day the run finished: its number, every bot's state, and the bot days it played. */
export type DayDone = { day: number; states: ReadonlyMap<string, BotState>; played: { name: string; line: DayLine }[] };

/** The day's line for one bot (D19, D22): what Task 10's issue comment prints, and the run log. */
export function formatLine(name: string, line: DayLine): string {
  if (!line.played && line.completed) return `${name} day ${line.day} (${line.date}): rested`;
  const share = line.cards > 0 ? Math.round((100 * line.right) / line.cards) : 0;
  return (
    `${name} day ${line.day} (${line.date}): ${line.completed ? 'done' : 'FAILED'}, ` +
    `sessions ${line.sessions}, cards ${line.cards}, right ${line.right} (${share}%), new words ${line.newWords}, ` +
    `unheard ${line.unheard}, no voice ${line.noVoice}, unmatched ${line.unmatched}, failed requests ${line.failed}`
  );
}

/** Every bot day the run played, in order. */
export async function runDays(opts: RunOptions): Promise<{ name: string; line: DayLine }[]> {
  const played: { name: string; line: DayLine }[] = [];
  for (let i = 0; i < opts.days; i++) {
    const states = new Map<string, BotState>();
    for (const profile of opts.profiles) states.set(profile.name, await opts.store.load(profile.name));
    const day = Math.min(...[...states.values()].map((s) => s.day)) + 1;
    if (opts.beforeDay) await opts.beforeDay({ day, states });
    opts.log(`--- day ${day} (${dateOf(day)})`);
    const today: { name: string; line: DayLine }[] = [];
    for (const profile of opts.profiles) {
      const state = states.get(profile.name)!;
      if (state.day >= day) {
        opts.log(`${profile.name}: already played day ${day}`);
        continue;
      }
      const line = await playBot(opts, profile, state, day);
      opts.log(formatLine(profile.name, line));
      played.push({ name: profile.name, line });
      today.push({ name: profile.name, line });
    }
    if (opts.afterDay) await opts.afterDay({ day, states, played: today });
  }
  if (opts.afterRun) await opts.afterRun();
  return played;
}

async function playBot(opts: RunOptions, profile: Profile, state: BotState, day: number): Promise<DayLine> {
  const line = newLine(day);
  state.days.push(line);
  const checkpoint = (what: string) => opts.store.save(state, `${profile.name}: day ${day}, ${what}`);
  let api: BotApi | undefined;
  let crashed = false;
  try {
    try {
      api = opts.apiFor(await opts.route.signIn(profile.name));
      await opts.route.setDay(profile.name, dateOf(day));
      await playDay({ api, profile, state, words: opts.wordsFor(profile), synthesize: opts.synthesize, log: opts.log, poll: opts.poll, line, day, checkpoint });
      line.completed = true;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      line.failed += 1;
      opts.log(`${profile.name}: ${error.message}`);
    } finally {
      // A bot session lasts a day; ending it keeps session rows from piling up (Task 7).
      if (api) {
        await api.signOut().catch((error: unknown) => {
          if (!(error instanceof ApiError)) throw error;
          opts.log(`${profile.name}: sign-out failed: ${error.message}`);
        });
      }
    }
  } catch (error) {
    crashed = true;
    throw error;
  } finally {
    settle(opts, profile, state, day, line);
    const outcome = line.completed ? 'done' : crashed ? 'crashed' : 'failed';
    if (crashed) {
      // The crash is what the run reports; a save that fails as well is only logged.
      await checkpoint(outcome).catch((error: unknown) => opts.log(`${profile.name}: saving after the crash failed: ${String(error)}`));
    } else {
      await checkpoint(outcome);
    }
  }
  return line;
}

/** After an attempt: a finished day moves the bot on; an unfinished one counts an attempt. */
function settle(opts: RunOptions, profile: Profile, state: BotState, day: number, line: DayLine): void {
  if (line.completed) {
    state.day = day;
    state.attempts = 0;
  } else if (++state.attempts >= MAX_DAY_ATTEMPTS) {
    opts.log(`${profile.name}: day ${day} failed ${state.attempts} times; counted as played`);
    state.day = day;
    state.attempts = 0;
  }
  if (state.day >= day) delete state.progress;
}
