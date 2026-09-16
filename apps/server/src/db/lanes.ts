import { sql } from 'drizzle-orm';

import { assertDatabaseIdentifier } from '../config';
import type { Db } from './client';

export type LaneDatabaseRow = { name: string; comment: string | null };

// `lang_tutor` itself and anything prefixed `lang_tutor_`. Per-test databases
// are deliberately outside this: one integration run leaves upwards of a
// hundred, and they belong to the harness that sweeps them, not to a listing a
// human reads.
const LANE_DATABASE_PATTERN = '^lang_tutor(_|$)';

export async function listLaneDatabases(db: Db): Promise<LaneDatabaseRow[]> {
  const result = await db.execute<{ name: string; comment: string | null }>(sql`
    select datname as name, shobj_description(oid, 'pg_database') as comment
    from pg_database
    where datname ~ ${LANE_DATABASE_PATTERN}
    order by datname
  `);
  return result.rows;
}

/**
 * Everything one lane owns: its dev database, its e2e database and every
 * per-test database its suites left behind.
 *
 * Anchored alternation rather than a prefix match, because `t_<lane>_` is the
 * only one of the three that is a prefix — `lang_tutor_<lane>` must not also
 * sweep `lang_tutor_<lane>_something`, which is a different lane's.
 */
export async function dropLaneDatabases(db: Db, lane: string): Promise<string[]> {
  if (!lane) throw new Error('a lane name is required');
  if (lane === 'main') {
    throw new Error('refusing to drop lane 0 — lang_tutor is the shared dictionary');
  }
  assertDatabaseIdentifier(lane);

  const pattern = `^(lang_tutor_${lane}|lang_tutor_e2e_${lane}|t_${lane}_.*)$`;
  const found = await db.execute<{ datname: string }>(
    sql`select datname from pg_database where datname ~ ${pattern} order by datname`,
  );

  const dropped: string[] = [];
  for (const { datname } of found.rows) {
    const quoted = `"${datname.replace(/"/g, '""')}"`;
    await db.execute(sql.raw(`drop database if exists ${quoted} with (force)`));
    dropped.push(datname);
  }
  return dropped;
}
