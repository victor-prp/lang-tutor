import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { Dimension, QuestionType } from '@lang-tutor/core/domain';
import type { AnswerVerdict } from '@lang-tutor/core/api';

import type { ActrState } from './actr.ts';
import type { Outcome, SavedWord } from './answer.ts';
import type { FsrsState } from './fsrsBot.ts';
import type { Profile } from './roster.ts';

/**
 * Spec D17. What a bot really knows, kept off production: one directory per bot on the orphan
 * branch `bots-state`, read at the start of a run and committed as soon as that bot's day is
 * done. `<bot>/state.json` holds the bot; `<bot>/log.jsonl` its append-only log of cards, one
 * line each.
 */

/** A saved word, with the gloss it was saved as and the simulated day it was saved on. */
export type SavedEntry = SavedWord & { glossId: string; day: number };

/** One card as the bot met it: what it showed, what the bot knew, what it sent, how it was judged. */
export type CardEntry = {
  day: number;
  date: string;
  /** Simulated hour of the day, fractional: each card takes a minute. */
  hour: number;
  session: string;
  card: string;
  type: QuestionType;
  /** The saved word the bot matched the card to; null when it could not (unmatched). */
  word: string | null;
  /** What an unmatched card showed, so the log says why it did not match. */
  shown?: string;
  dimensions: Dimension[];
  /** The bot's true recall per tested dimension, before the card: the hidden truth (D21). */
  recall: Partial<Record<Dimension, number>>;
  /** The chance of a right answer the bot drew against, guessing included. */
  p: number;
  /** What the bot meant to do. */
  outcome: Outcome;
  /** What it sent: the option's index, the text, `pass:<kind>`, or `spoke:<text>`. */
  answer: string;
  /** The server's verdict, which the bot learns from (ruling 24); absent on a choice. */
  verdict?: AnswerVerdict;
  correct: boolean;
  /** On a speaking card: what became of the attempt. */
  heard?: 'heard' | 'unheard' | 'no_voice';
};

/** One bot's simulated day, as the daily line counts it (D19, D22). */
export type DayLine = {
  day: number;
  date: string;
  played: boolean;
  /** False when a failed request ended the day early: the day is played again next run. */
  completed: boolean;
  sessions: number;
  cards: number;
  right: number;
  newWords: number;
  unheard: number;
  /** Speaking cards passed because no voice could be made (espeak-ng or ffmpeg missing). */
  noVoice: number;
  unmatched: number;
  failed: number;
};

export type BotState = {
  name: string;
  /** The last simulated day the bot finished; 0 before its first. */
  day: number;
  /** Failed attempts at day + 1 so far. */
  attempts: number;
  /** The next word of its list to look up. */
  position: number;
  saved: SavedEntry[];
  /** ACT-R traces and hidden difficulties, or the control bot's FSRS states. */
  memory: ActrState | FsrsState;
  days: DayLine[];
  log: CardEntry[];
};

export function newState(profile: Pick<Profile, 'name' | 'memory'>): BotState {
  return {
    name: profile.name,
    day: 0,
    attempts: 0,
    position: 0,
    saved: [],
    memory: profile.memory === 'actr' ? { traces: {}, shifts: {} } : {},
    days: [],
    log: [],
  };
}

export interface StateStore {
  /** The bot's state, or a new one for a bot never seen. */
  load(name: string): Promise<BotState>;
  /** Writes the bot's state and commits it. */
  save(state: BotState, message: string): Promise<void>;
}

/** Test support, and nothing else: a store that forgets when the process ends. */
export function memoryStore(): StateStore {
  const saved = new Map<string, string>();
  return {
    load: async (name) => {
      const json = saved.get(name);
      return json ? (JSON.parse(json) as BotState) : newState({ name, memory: 'actr' });
    },
    save: async (state) => {
      saved.set(state.name, JSON.stringify(state));
    },
  };
}

const run = promisify(execFile);

/** Commits as the bots, whoever runs the driver: a CI runner has no git identity. */
const IDENTITY = ['-c', 'user.name=lang-tutor bots', '-c', 'user.email=bots@users.noreply.github.com'];

export const STATE_BRANCH = 'bots-state';

class GitStore implements StateStore {
  constructor(
    private readonly dir: string,
    private readonly push: { remote: string; branch: string } | null,
    private readonly memory: (name: string) => Profile['memory'],
  ) {}

  private git(...args: string[]) {
    return run('git', args, { cwd: this.dir, maxBuffer: 64 * 1024 * 1024 });
  }

  async load(name: string): Promise<BotState> {
    const file = join(this.dir, name, 'state.json');
    if (!existsSync(file)) return newState({ name, memory: this.memory(name) });
    const state = JSON.parse(readFileSync(file, 'utf8')) as Omit<BotState, 'log'>;
    const logFile = join(this.dir, name, 'log.jsonl');
    const log = existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as CardEntry)
      : [];
    return { ...state, log };
  }

  async save(state: BotState, message: string): Promise<void> {
    const { log, ...rest } = state;
    mkdirSync(join(this.dir, state.name), { recursive: true });
    writeFileSync(join(this.dir, state.name, 'state.json'), `${JSON.stringify(rest)}\n`);
    writeFileSync(join(this.dir, state.name, 'log.jsonl'), log.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
    await this.git('add', '--', state.name);
    const { stdout } = await this.git('status', '--porcelain', '--', state.name);
    if (stdout.trim() === '') return;
    await this.git(...IDENTITY, 'commit', '--quiet', '-m', message, '--', state.name);
    if (this.push) await this.git('push', '--quiet', this.push.remote, `HEAD:${this.push.branch}`);
  }
}

const memoryOf = (profiles: readonly Pick<Profile, 'name' | 'memory'>[]) => (name: string) =>
  profiles.find((p) => p.name === name)?.memory ?? 'actr';

/**
 * A dry run's state (spec §6): a git repository of its own in `dir`, made on first use, committed
 * per bot as the real one is and never pushed. It stays apart from the `bots-state` branch, so a
 * lane can play days without touching production's bots.
 */
export async function openScratchStore(dir: string, profiles: readonly Pick<Profile, 'name' | 'memory'>[] = []): Promise<StateStore> {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, '.git'))) await run('git', ['init', '--quiet', '-b', STATE_BRANCH], { cwd: dir });
  return new GitStore(dir, null, memoryOf(profiles));
}

/**
 * The real run's state (D17): the orphan branch `bots-state`, checked out with `git worktree add`
 * at `dir` (bots/.state, ignored). Taken from the remote when it has the branch, made as an
 * orphan when nobody has, and pushed after every bot's commit, so a run that dies keeps every
 * bot it finished.
 */
export async function openStateCheckout(opts: {
  repoRoot: string;
  dir: string;
  remote?: string;
  profiles: readonly Pick<Profile, 'name' | 'memory'>[];
}): Promise<StateStore> {
  const remote = opts.remote ?? 'origin';
  const git = (...args: string[]) => run('git', args, { cwd: opts.repoRoot });
  // Absent and unreadable are different answers. Only `ls-remote --exit-code` saying the branch
  // is not there (exit 2) means "no state yet"; any other failure (network, auth, a checkout
  // without the remote) throws. Read as absent, it would make an orphan with every bot on day 0
  // and move production's bots back to day 1 before the push failed.
  const exists = await git('ls-remote', '--exit-code', '--heads', remote, STATE_BRANCH).then(
    () => true,
    (error: { code?: unknown; stderr?: string }) => {
      if (error.code === 2) return false;
      throw new Error(`cannot read ${STATE_BRANCH} from ${remote}: ${String(error.stderr ?? error).trim()}`);
    },
  );
  if (exists) await git('fetch', '--quiet', remote, STATE_BRANCH);
  const fetched = exists;
  if (!existsSync(opts.dir)) {
    const local = await git('rev-parse', '--verify', '--quiet', `refs/heads/${STATE_BRANCH}`).then(
      () => true,
      () => false,
    );
    if (fetched) await git('worktree', 'add', '--quiet', '-B', STATE_BRANCH, opts.dir, `${remote}/${STATE_BRANCH}`);
    else if (local) await git('worktree', 'add', '--quiet', opts.dir, STATE_BRANCH);
    else await git('worktree', 'add', '--quiet', '--orphan', '-b', STATE_BRANCH, opts.dir);
  } else if (fetched) {
    await run('git', ['merge', '--quiet', '--ff-only', `${remote}/${STATE_BRANCH}`], { cwd: opts.dir });
  }
  return new GitStore(opts.dir, { remote, branch: STATE_BRANCH }, memoryOf(opts.profiles));
}
