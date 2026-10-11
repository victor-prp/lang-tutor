import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { createApi } from './src/api.ts';
import { runDays } from './src/driver.ts';
import { fileSink, ghSink } from './src/issue.ts';
import { claudeRunner, commandRunner, createReporter, dryReporter } from './src/report.ts';
import { ROSTER } from './src/roster.ts';
import { createSynthesizer } from './src/speech.ts';
import { openScratchStore, openStateCheckout } from './src/state.ts';
import { weeklyIssue } from './src/week.ts';
import { loadWords, type WordSource } from './src/words.ts';

/**
 * The bots' driver (spec D18, §6).
 *
 *   tsx bots/run.ts [--dry-run] [--days N] [--bots a,b] [--api URL] [--words list|fixtures] [--state DIR]
 *
 * A real run plays against `--api` (or BOTS_API_URL) and keeps state on the `bots-state` branch,
 * checked out at bots/.state and pushed after every bot. A dry run (`npm run bots:dry`, which
 * goes through the lane wrapper) plays against this lane's server by default and keeps its state
 * in a repository of its own under bots/.dry/<lane>, never pushed. Either needs BOT_SECRET, the
 * server's own. A failed request is counted, not fatal; a dry run still exits 1 on one, being a
 * test of the driver. Anything else wrong fails the run.
 *
 * After each day the week's issue gets the day's lines, and the week's last day closes it with
 * the five numbers and a Claude-written report per bot (D20–D22). A real run files through `gh`
 * (GH_TOKEN) and reports through `claude` (CLAUDE_CODE_OAUTH_TOKEN), tagging the spend with
 * GITHUB_RUN_ID. A dry run makes no Claude call and files nothing: the issue's text goes to
 * <state>/issues/week-N.md.
 */
const HERE = fileURLToPath(new URL('.', import.meta.url));

function fail(message: string): never {
  console.error(`bots: ${message}`);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    days: { type: 'string', default: '1' },
    bots: { type: 'string' },
    api: { type: 'string' },
    words: { type: 'string', default: 'list' },
    // A dry run's state directory, when the lane's default is not the one: CI's run against
    // the e2e server keeps its own, apart from a dry run against the lane's dev server.
    state: { type: 'string' },
  },
});

const dry = values['dry-run'];
const days = Number(values.days);
if (!Number.isInteger(days) || days < 1) fail(`--days takes a whole number of days, not ${values.days}`);
const words = values.words as WordSource;
if (words !== 'list' && words !== 'fixtures') fail(`--words is list or fixtures, not ${values.words}`);

const names = values.bots?.split(',').map((n) => n.trim()).filter(Boolean);
const unknown = names?.filter((n) => !ROSTER.some((p) => p.name === n)) ?? [];
if (unknown.length > 0) fail(`no bot named ${unknown.join(', ')}; the roster is ${ROSTER.map((p) => p.name).join(', ')}`);
const profiles = names ? ROSTER.filter((p) => names.includes(p.name)) : ROSTER;

const secret =
  process.env.BOT_SECRET?.trim() ||
  fail('BOT_SECRET is not set: the server mounts the bot route only with it, and the driver signs in with it');

// A dry run's server is this lane's, whose port the lane wrapper exports (ADR 0006). An empty
// value is no value: GitHub expands an unset `vars.BOTS_API_URL` to ''.
const given = (value: string | undefined) => value?.trim() || undefined;
const lanePort = given(process.env.PORT);
const baseUrl =
  given(values.api) ??
  (dry ? (lanePort ? `http://localhost:${lanePort}` : undefined) : given(process.env.BOTS_API_URL)) ??
  fail(dry ? 'no --api and no PORT: run it as npm run bots:dry, through the lane wrapper' : 'no --api and no BOTS_API_URL');
// Checked before anything is opened or sent: a run against no server would fail every request,
// and three such runs count every bot's day as played.
if (!URL.canParse(baseUrl) || !['http:', 'https:'].includes(new URL(baseUrl).protocol)) {
  fail(`the API address ${JSON.stringify(baseUrl)} is not an http(s) URL`);
}

async function main(): Promise<void> {
  const dryDir = values.state ?? join(HERE, '.dry', process.env.LANE?.trim() || 'local');
  const store = dry
    ? await openScratchStore(dryDir, profiles)
    : await openStateCheckout({ repoRoot: join(HERE, '..'), dir: join(HERE, '.state'), profiles });
  const runId = given(process.env.GITHUB_RUN_ID) ?? 'local';
  const sink = dry ? fileSink(join(dryDir, 'issues')) : ghSink(commandRunner('gh'));
  const reporter = dry ? dryReporter(runId) : createReporter({ run: claudeRunner(), runId });

  const api = createApi({ baseUrl, secret });
  console.log(`bots: ${dry ? 'dry run' : 'run'} of ${days} day(s) for ${profiles.map((p) => p.name).join(', ')} against ${baseUrl}`);

  const played = await runDays({
    profiles,
    days,
    route: api.route,
    apiFor: (cookie) => api.as(cookie),
    store,
    wordsFor: (profile) => loadWords(profile.language, words),
    synthesize: createSynthesizer(),
    log: (line) => console.log(line),
    ...weeklyIssue({ profiles, store, sink, reporter, log: (line) => console.log(line) }),
  });

  const failed = played.filter(({ line }) => line.failed > 0);
  if (dry && failed.length > 0) {
    console.error(`bots: ${failed.length} bot day(s) ended on a failed request: ${failed.map((f) => `${f.name} day ${f.line.day}`).join(', ')}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
