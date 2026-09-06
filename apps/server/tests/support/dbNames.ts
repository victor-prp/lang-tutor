const HOST = process.env.PGHOST ?? 'localhost';
const PORT = process.env.PGPORT ?? '5432';

/** The maintenance database. CREATE/DROP DATABASE cannot run from inside the target. */
export const ADMIN_URL = `postgres://postgres:postgres@${HOST}:${PORT}/postgres`;

export function urlFor(name: string): string {
  return `postgres://postgres:postgres@${HOST}:${PORT}/${name}`;
}

// One template per Jest worker, not one shared template: CREATE DATABASE locks
// its template for the duration of the copy, so a single template would make
// every worker serialise on it.
//
// The `t_tmpl_` prefix is one of the two globalSetup's sweep reclaims, so a
// template outliving the run that made it is picked up next time. Dropping
// templates by exact worker number was the leak: a 4-worker run followed by a
// 2-worker run stranded 3 and 4 permanently, because nothing ever looked for them.
export function templateName(workerId: string | number): string {
  return `t_tmpl_${workerId}`;
}

/** Postgres truncates identifiers past this silently, which would collide names. */
const MAX_IDENTIFIER_BYTES = 63;

/**
 * A test name reduced to an identifier body. Not exported — nothing outside this
 * module needs it, and `tests/support/` is matched by neither Jest project, so
 * an exported-for-testing seam here would have nowhere to be tested from.
 * Slugifying to `[a-z0-9_]` first is
 * also what makes the byte budget below a character count: every surviving
 * character is one byte, so no multi-byte test name can overrun the limit.
 */
function slugify(testName: string): string {
  return testName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * `t_test_<slug>_<random>`. The slug says which test this database served; the
 * random suffix is what keeps two tests whose names share a prefix from
 * colliding after truncation. The full, untruncated name goes in the database's
 * COMMENT — see testDb.ts.
 */
export function testDbName(testName: string, random: string): string {
  const prefix = 't_test_';
  const budget = MAX_IDENTIFIER_BYTES - prefix.length - 1 - random.length;
  const slug = slugify(testName).slice(0, budget).replace(/_+$/, '') || 'unnamed';
  return `${prefix}${slug}_${random}`;
}

/** Jest sets JEST_WORKER_ID from 1; it is unset outside a worker. */
export function currentWorkerId(): string {
  return process.env.JEST_WORKER_ID ?? '1';
}
