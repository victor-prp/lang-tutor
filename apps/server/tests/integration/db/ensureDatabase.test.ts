import { afterAll, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createDb } from '../../../src/db/client';
import {
  ensureDatabase,
  formatLaneComment,
  laneStampFrom,
  parseLaneComment,
} from '../../../src/db/ensureDatabase';
import { loadConfig } from '../../../src/config';
import { ADMIN_URL, urlFor } from '../../support/dbNames';
import { DROP_TIMEOUT_MS, dropDatabases } from '../../support/dropDatabases';

// A name of its own, outside the t_ sweep patterns, because this test creates a
// database the way a lane does rather than the way the harness does — and drops
// it itself in afterEach.
const NAME = 'lang_tutor_ensure_probe';

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

// Once for the file, not after every test. See tests/support/dropDatabases.ts:
// a DROP DATABASE waits on a checkpoint that this suite's other workers keep
// busy, so it is far too expensive to pay five times over.
afterAll(() => dropDatabases([NAME]), DROP_TIMEOUT_MS);

describe('ensureDatabase', () => {
  it('creates the database when it does not exist', async () => {
    // The one drop inside a test, and the reason is the assertion below: this is
    // the only case that needs the database to be absent, and saying so here is
    // what keeps it from depending on which test ran before it.
    await dropDatabases([NAME]);

    const created = await ensureDatabase(urlFor(NAME), STAMP);
    expect(created).toBe(true);

    const found = await admin((db) =>
      db.execute<{ datname: string }>(sql`select datname from pg_database where datname = ${NAME}`),
    );
    expect(found.rows).toHaveLength(1);
  }, DROP_TIMEOUT_MS);

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
