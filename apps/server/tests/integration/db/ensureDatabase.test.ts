import { randomUUID } from 'node:crypto';

import { describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createDb } from '../../../src/db/client';
import {
  ensureDatabase,
  formatLaneComment,
  laneStampFrom,
  parseLaneComment,
} from '../../../src/db/ensureDatabase';
import { loadConfig } from '../../../src/config';
import { ADMIN_URL, testDbName, urlFor } from '../../support/dbNames';

// Fresh names for every run, named like per-test databases so the next run's
// sweep reclaims them, and never dropped here: a DROP DATABASE waits for a
// server-wide checkpoint, which the other workers' clones keep slow. A name no
// run has used before is also how "does not exist yet" is arranged without a
// drop, and it keeps two lanes running the suite at once apart.
const fresh = (label: string) => testDbName(label, randomUUID().slice(0, 8));
const NAME = fresh('ensure_probe');

const STAMP = {
  lane: 'ensure_probe',
  slot: '7',
  port: '10001',
  root: '/tmp/worktrees/ensure-probe',
  branch: 'feature/ensure-probe',
};

async function admin<T>(fn: (db: ReturnType<typeof createDb>['db']) => Promise<T>): Promise<T> {
  const handle = createDb(ADMIN_URL, { max: 1, onError: () => {} });
  try {
    return await fn(handle.db);
  } finally {
    await handle.close();
  }
}

describe('ensureDatabase', () => {
  it('creates the database when it does not exist', async () => {
    // A name of its own rather than NAME, so this does not depend on which test
    // ran before it.
    const absent = fresh('ensure_absent');
    const created = await ensureDatabase(urlFor(absent), STAMP);
    expect(created).toBe(true);

    const found = await admin((db) =>
      db.execute<{ datname: string }>(sql`select datname from pg_database where datname = ${absent}`),
    );
    expect(found.rows).toHaveLength(1);
  });

  it('is idempotent: a second call creates nothing and does not throw', async () => {
    await ensureDatabase(urlFor(NAME), STAMP);
    expect(await ensureDatabase(urlFor(NAME), STAMP)).toBe(false);
  });

  it('stamps the database with the worktree and branch that own it', async () => {
    await ensureDatabase(urlFor(NAME), STAMP);

    const result = await admin((db) =>
      db.execute<{ comment: string | null }>(sql`
        select shobj_description(oid, 'pg_database') as comment
        from pg_database where datname = ${NAME}
      `),
    );
    const parsed = parseLaneComment(result.rows[0]?.comment ?? null);
    expect(parsed.lane).toBe('ensure_probe');
    expect(parsed.slot).toBe('7');
    expect(parsed.port).toBe('10001');
    expect(parsed.root).toBe('/tmp/worktrees/ensure-probe');
    expect(parsed.branch).toBe('feature/ensure-probe');
    expect(parsed.stamped).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('refreshes the stamp on a database that already exists', async () => {
    await ensureDatabase(urlFor(NAME), STAMP);
    await ensureDatabase(urlFor(NAME), { ...STAMP, branch: 'feature/renamed' });

    const result = await admin((db) =>
      db.execute<{ comment: string | null }>(sql`
        select shobj_description(oid, 'pg_database') as comment
        from pg_database where datname = ${NAME}
      `),
    );
    expect(parseLaneComment(result.rows[0]?.comment ?? null).branch).toBe('feature/renamed');
  });

  it('refuses a database name that is not a bare identifier', async () => {
    await expect(ensureDatabase(urlFor('drop me'), STAMP)).rejects.toThrow('database identifier');
  });
});

// Pure, and tested here rather than in src/: ADR 0004 R2 keeps a unit test away
// from anything that imports db/client.ts, and these ship in the module that
// does.
describe('the lane comment', () => {
  it('round-trips every field', () => {
    const comment = formatLaneComment(STAMP, new Date('2026-09-16T10:00:00.000Z'));
    expect(parseLaneComment(comment)).toEqual({ ...STAMP, stamped: '2026-09-16T10:00:00.000Z' });
  });

  it('survives a worktree path containing the separator', () => {
    const odd = { ...STAMP, root: '/tmp/a | b/wt' };
    const comment = formatLaneComment(odd, new Date('2026-09-16T10:00:00.000Z'));
    expect(parseLaneComment(comment).root).toBe('/tmp/a | b/wt');
  });

  it('reads an unstamped database as empty rather than throwing', () => {
    expect(parseLaneComment(null)).toEqual({});
    expect(parseLaneComment('a database somebody made by hand')).toEqual({});
  });
});

describe('laneStampFrom', () => {
  it('takes lane 0 as the default for an empty environment', () => {
    expect(laneStampFrom({})).toEqual({
      lane: 'main',
      slot: '0',
      // Read from config rather than written out again: lane 0's port default
      // has one home, and this asserts the stamp takes it from there.
      port: String(loadConfig({}).port),
      root: process.cwd(),
      branch: 'unknown',
    });
  });

  it('takes every field from the environment when the wrapper set it', () => {
    expect(
      laneStampFrom({
        LANE: 'phase_15',
        LANE_SLOT: '1',
        PORT: '4001',
        LANE_ROOT: '/w/phase-15',
        LANE_BRANCH: 'phase-15-lanes',
      }),
    ).toEqual({
      lane: 'phase_15',
      slot: '1',
      port: '4001',
      root: '/w/phase-15',
      branch: 'phase-15-lanes',
    });
  });
});
