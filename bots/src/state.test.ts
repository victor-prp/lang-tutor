import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ROSTER } from './roster.ts';
import { newState, openScratchStore, openStateCheckout } from './state.ts';

test('a bot never seen starts on day 0 with nothing saved', () => {
  const state = newState(ROSTER[0]);
  assert.equal(state.day, 0);
  assert.equal(state.position, 0);
  assert.deepEqual(state.saved, []);
  assert.deepEqual(state.log, []);
});

test('the git store writes <bot>/state.json and log.jsonl and commits once per bot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bots-state-'));
  try {
    const store = await openScratchStore(dir);
    const one = await store.load('one-en');
    one.day = 1;
    one.log.push({ day: 1 } as never, { day: 1 } as never);
    await store.save(one, 'one-en: day 1');
    const two = await store.load('two-en');
    two.day = 1;
    await store.save(two, 'two-en: day 1');

    const subjects = execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(subjects, ['two-en: day 1', 'one-en: day 1']);
    assert.equal(readFileSync(join(dir, 'one-en', 'log.jsonl'), 'utf8').trim().split('\n').length, 2);
    assert.equal(JSON.parse(readFileSync(join(dir, 'one-en', 'state.json'), 'utf8')).log, undefined);

    // A second store over the same checkout reads what the first committed.
    const again = await (await openScratchStore(dir)).load('one-en');
    assert.equal(again.day, 1);
    assert.equal(again.log.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saving an unchanged bot makes no empty commit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bots-state-'));
  try {
    const store = await openScratchStore(dir);
    const one = await store.load('one-en');
    await store.save(one, 'first');
    await store.save(one, 'second');
    const subjects = execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(subjects, ['first']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real store makes the orphan branch once, pushes every bot, and a fresh checkout reads it back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bots-remote-'));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
  try {
    git(root, 'init', '--quiet', '--bare', 'remote.git');
    // A repository with history of its own, as the real one is: the state branch shares none of it.
    for (const clone of ['a', 'b']) git(root, 'clone', '--quiet', 'remote.git', clone);
    git(join(root, 'a'), ...ID, 'commit', '--quiet', '--allow-empty', '-m', 'code');
    git(join(root, 'a'), 'push', '--quiet', 'origin', 'HEAD:master');

    const first = await openStateCheckout({ repoRoot: join(root, 'a'), dir: join(root, 'a', 'bots', '.state'), profiles: [] });
    const one = await first.load('one-en');
    one.day = 1;
    await first.save(one, 'one-en: day 1');

    assert.equal(git(root, '-C', 'remote.git', 'log', '--format=%s', 'bots-state'), 'one-en: day 1');
    assert.equal(git(root, '-C', 'remote.git', 'rev-list', '--count', 'bots-state'), '1', 'an orphan: no code history');

    const second = await openStateCheckout({ repoRoot: join(root, 'b'), dir: join(root, 'b', 'bots', '.state'), profiles: [] });
    assert.equal((await second.load('one-en')).day, 1);
    const again = await second.load('one-en');
    again.day = 2;
    await second.save(again, 'one-en: day 2');

    // The first checkout, opened again, fast-forwards to what the second pushed.
    const reopened = await openStateCheckout({ repoRoot: join(root, 'a'), dir: join(root, 'a', 'bots', '.state'), profiles: [] });
    assert.equal((await reopened.load('one-en')).day, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a remote that cannot be read is a failure, never "no state yet": no orphan is made', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bots-remote-'));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    git(root, 'init', '--quiet', 'repo');
    // An origin nobody can reach, as a network, auth or checkout misconfiguration leaves it.
    git(join(root, 'repo'), 'remote', 'add', 'origin', join(root, 'no-such-remote.git'));
    const dir = join(root, 'repo', 'bots', '.state');
    await assert.rejects(openStateCheckout({ repoRoot: join(root, 'repo'), dir, profiles: [] }), /bots-state/);
    assert.equal(existsSync(dir), false, 'no checkout was made');
    assert.equal(git(join(root, 'repo'), 'branch', '--list', 'bots-state'), '', 'no orphan branch was made');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
