import { sql } from 'drizzle-orm';

import { assertDatabaseIdentifier, databaseNameFrom, maintenanceUrlFor } from '../config';
import { createDb } from './client';

/**
 * Who owns a database on the shared Postgres. Every value is a string because
 * every value came from the environment, and re-parsing a port only to print it
 * again would buy nothing.
 */
export type LaneStamp = {
  lane: string;
  slot: string;
  port: string;
  root: string;
  branch: string;
};

/** The lane this process belongs to, defaulting to lane 0 field by field. */
export function laneStampFrom(env: NodeJS.ProcessEnv): LaneStamp {
  return {
    lane: env.LANE?.trim() || 'main',
    slot: env.LANE_SLOT?.trim() || '0',
    port: env.PORT?.trim() || '3001',
    // A checkout run outside the wrapper still stamps something true: cwd is
    // where the command was issued.
    root: env.LANE_ROOT?.trim() || process.cwd(),
    branch: env.LANE_BRANCH?.trim() || 'unknown',
  };
}

// ` | ` separates fields and `=` separates key from value. A worktree path may
// contain either, so parsing splits on the FIRST `=` per field and the value is
// whatever follows — which is why the fields are written in a fixed order and
// read back by key rather than by position.
const SEPARATOR = ' | ';

export function formatLaneComment(stamp: LaneStamp, now: Date): string {
  return [
    `lane=${stamp.lane}`,
    `slot=${stamp.slot}`,
    `port=${stamp.port}`,
    `branch=${stamp.branch}`,
    `stamped=${now.toISOString()}`,
    // Last, and deliberately: a path is the one field that can contain the
    // separator, so nothing has to be parsed after it.
    `root=${stamp.root}`,
  ].join(SEPARATOR);
}

export function parseLaneComment(
  comment: string | null,
): Partial<LaneStamp> & { stamped?: string } {
  if (!comment) return {};
  const out: Record<string, string> = {};
  // `root=` is last and may contain the separator, so it is taken whole from
  // where it starts rather than from a split.
  const rootAt = comment.indexOf(`${SEPARATOR}root=`);
  const head = rootAt === -1 ? comment : comment.slice(0, rootAt);
  if (rootAt !== -1) out.root = comment.slice(rootAt + SEPARATOR.length + 'root='.length);

  for (const field of head.split(SEPARATOR)) {
    const at = field.indexOf('=');
    if (at === -1) continue;
    out[field.slice(0, at)] = field.slice(at + 1);
  }
  // A comment somebody wrote by hand is not a stamp; report nothing rather than
  // a half-read one.
  if (!out.lane) return {};
  return out;
}

/**
 * Creates the database named by `databaseUrl` if it is absent, then stamps it.
 *
 * A lane's database is not in any migration and nothing else creates it — a
 * fresh worktree would otherwise have to be told a `createdb` command it cannot
 * derive. Resolves true when it created one, false when it was already there;
 * the stamp is rewritten either way, so a renamed branch is reflected on the
 * next migrate.
 */
export async function ensureDatabase(databaseUrl: string, stamp: LaneStamp): Promise<boolean> {
  const name = databaseNameFrom(databaseUrl);
  // Before connecting anywhere: an illegal name is a bug in the formula, and it
  // must not reach an interpolated statement even to fail there.
  assertDatabaseIdentifier(name);

  const admin = createDb(maintenanceUrlFor(databaseUrl), { max: 1, onError: () => {} });
  try {
    const existing = await admin.db.execute<{ datname: string }>(
      sql`select datname from pg_database where datname = ${name}`,
    );
    const created = existing.rows.length === 0;
    if (created) {
      // An identifier cannot be a bound parameter. assertDatabaseIdentifier
      // above is what makes this interpolation safe.
      await admin.db.execute(sql.raw(`create database ${name}`));
    }
    const comment = formatLaneComment(stamp, new Date()).replace(/'/g, "''");
    await admin.db.execute(sql.raw(`comment on database ${name} is '${comment}'`));
    return created;
  } finally {
    await admin.close();
  }
}
