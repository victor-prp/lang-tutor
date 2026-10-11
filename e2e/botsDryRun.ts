import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { request } from '@playwright/test';

import { serverEnv } from './serverEnv';
import { expectGeneration } from './tests/support/cards';
import { clearGemini, expectGeminiMatching, userText } from './tests/support/mockServer';
import { API_URL, requireEnv } from './urls';

/**
 * Phase 35 (spec §6, ruling 5). The bots' dry run in CI, after the e2e suite in the same job:
 * the e2e server started again on the same port, database and MockServer namespace, this time
 * with BOT_SECRET, which mounts the bot route. Its expectations are registered after e2e is
 * done, so they cannot clash with a spec's. It then creates the bot and runs
 *
 *   npm run bots:dry -- --days 1 --bots steady-en --words fixtures --api <the e2e server> --state <its own>
 *
 * against the ten-word fixture lists, and exits with the driver's code: a failed request in a
 * dry run is a failure. Run it as `npm run bots:ci`, through the lane wrapper.
 */
const REPO_ROOT = path.resolve(__dirname, '..');
const BOTS = ['steady-en'];
/** The run's own state. Wiped first: the e2e database it matches is rebuilt by every e2e run. */
const STATE_DIR = path.join(REPO_ROOT, 'bots', '.dry', `${serverEnv.LANE}-e2e`);

/** The Hebrew of every fixture word (bots/fixtures/words-*.txt), what its lookup answers. */
const MEANINGS: Record<string, string> = {
  ladle: 'מצקת', pebble: 'חלוק', kettle: 'קומקום', meadow: 'אחו', saddle: 'אוכף',
  thimble: 'אצבעון', harbor: 'נמל', candle: 'נר', walnut: 'אגוז', chimney: 'ארובה',
  ковш: 'מצקת', галька: 'חלוק', чайник: 'קומקום', луг: 'אחו', седло: 'אוכף',
  гавань: 'נמל', свеча: 'נר', орех: 'אגוז', дымоход: 'ארובה', кувшин: 'כד',
  mestolo: 'מצקת', ciottolo: 'חלוק', bollitore: 'קומקום', prato: 'אחו', sella: 'אוכף',
  porto: 'נמל', candela: 'נר', noce: 'אגוז', camino: 'ארובה', brocca: 'כד',
};

function fixtureWords(): string[] {
  return ['en', 'ru', 'it'].flatMap((language) =>
    readFileSync(path.join(REPO_ROOT, 'bots', 'fixtures', `words-${language}.txt`), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#')),
  );
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function waitForHealth(server: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`the server exited with ${server.exitCode}`);
    const ok = await fetch(`${API_URL}/health`).then((res) => res.ok, () => false);
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no answer from ${API_URL}/health in 60 s`);
}

/** Every model call the day can make: lookups by their text, then generation, judging and
 *  transcription. Unlimited, unlike the specs' one-shots: the bot answers as it likes. */
async function stub(): Promise<void> {
  const ctx = await request.newContext();
  try {
    await clearGemini(ctx);
    const words = fixtureWords();
    for (const word of words) {
      const meaning = MEANINGS[word];
      if (!meaning) throw new Error(`no meaning for the fixture word ${word}: add it to MEANINGS`);
      await expectGeminiMatching(
        ctx,
        userText(word),
        { kind: 'word', entries: [{ lemma: word, part_of_speech: 'noun', senses: [{ translation: meaning, sense_code: word }] }] },
        { priority: 10 },
      );
    }
    await expectGeminiMatching(ctx, "judge the learner's answer", { verdict: 'wrong' }, { priority: 20 });
    await expectGeminiMatching(ctx, 'transcribe the spoken audio', { heard: '' }, { priority: 20 });
    await expectGeneration(ctx);
    console.log(`bots:ci: stubbed ${words.length} lookups, generation, judging and transcription`);
  } finally {
    await ctx.dispose();
  }
}

async function main(): Promise<number> {
  const secret = requireEnv('BOT_SECRET');
  const env = { ...process.env, ...serverEnv, BOT_SECRET: secret };
  // Its own process group, so stopping it stops tsx under npm too.
  const server = spawn('npm', ['run', 'start', '-w', 'apps/server'], { cwd: REPO_ROOT, env, stdio: 'inherit', detached: true });
  try {
    await waitForHealth(server);
    await stub();
    // The driver puts the bot on its day before playing; this one only has to exist.
    const created = await run('npm', ['run', 'db:bots:create', '-w', 'apps/server', '--', '--day', '2026-01-01', ...BOTS], env);
    if (created !== 0) return created;
    rmSync(STATE_DIR, { recursive: true, force: true });
    return await run(
      'npm',
      [
        'run', 'bots:dry', '--', '--days', '1', '--bots', BOTS.join(','), '--words', 'fixtures', '--api', API_URL,
        // Its own state, apart from a dry run against the lane's dev server and database.
        '--state', STATE_DIR,
      ],
      { ...process.env, BOT_SECRET: secret },
    );
  } finally {
    if (server.pid !== undefined && server.exitCode === null) process.kill(-server.pid, 'SIGTERM');
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
