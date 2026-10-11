import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const RUN = fileURLToPath(new URL('../run.ts', import.meta.url));

/**
 * run.ts as a process, with only the environment given. PATH holds no git, so even a run that
 * wrongly got past its checks cannot open, commit or push the real bots-state branch (a first
 * draft of this test, run before the fix, did exactly that).
 */
function run(args: string[], env: Record<string, string>) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', RUN, ...args], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { PATH: '/nonexistent', BOT_SECRET: 'x'.repeat(40), ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

// Each of these must stop before the state is opened or any request is made: the run's first
// line names the server it plays against, so its absence shows nothing started.
const refused: [string, string[], Record<string, string>][] = [
  ['an empty BOTS_API_URL', [], { BOTS_API_URL: '' }],
  ['a blank BOTS_API_URL', [], { BOTS_API_URL: '   ' }],
  ['an empty --api', ['--api', ''], {}],
  ['an --api that is not a URL', ['--api', 'not a url'], {}],
  ['a BOTS_API_URL that is not http', [], { BOTS_API_URL: 'ftp://example.test' }],
];

for (const [what, args, env] of refused) {
  test(`${what} is refused before the run starts`, () => {
    const { status, out } = run(args, env);
    assert.equal(status, 2, out);
    assert.match(out, /bots: /);
    assert.doesNotMatch(out, /against/);
  });
}
