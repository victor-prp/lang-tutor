import { sql } from 'drizzle-orm';

import { assertDatabaseIdentifier } from '../config';
import type { Db } from './client';
import { parseLaneComment } from './ensureDatabase';

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
 *
 * The per-test part names the two shapes tests/support/dbNames.ts creates,
 * `t_<lane>_test_…` and `t_<lane>_tmpl_…`, rather than `t_<lane>_.*`: the bare
 * prefix also took every test database of a lane whose name extends this one's
 * (`phase_31` reached `t_phase_31_glosses_*`). A lane named `<lane>_test…` is
 * still reachable; that residue is accepted.
 */
export async function dropLaneDatabases(db: Db, lane: string): Promise<string[]> {
  if (!lane) throw new Error('a lane name is required');
  if (lane === 'main') {
    throw new Error('refusing to drop lane 0 — lang_tutor is the shared dictionary');
  }
  assertDatabaseIdentifier(lane);

  const pattern = `^(lang_tutor_${lane}|lang_tutor_e2e_${lane}|t_${lane}_(test|tmpl)_.*)$`;
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

export type LaneOrphans = {
  /** Lanes `lane:down` can drop whole: every database they own is stamped by a gone worktree. */
  orphans: { lane: string; databases: string[] }[];
  /** Lane databases with no stamp at all. Nothing says who owns them, so nothing drops them. */
  unowned: string[];
};

// Lane 0's, whether stamped or not. `lang_tutor_e2e` is created by the e2e
// harness rather than ensureDatabase, so it never carries a stamp.
const LANE_ZERO_DATABASES = new Set(['lang_tutor', 'lang_tutor_e2e']);

/**
 * Which lanes outlived their worktree. A lane counts only when EVERY one of its
 * stamped databases points at a root that is gone: `lane:down` drops a lane's
 * databases together, so a single database stamped by a worktree that still
 * exists makes the whole lane live.
 *
 * `exists` is injected so the rule is a pure function, and `lane:list` and
 * `lane:clean --orphans` cannot disagree about it.
 */
export function findOrphans(
  rows: LaneDatabaseRow[],
  exists: (path: string) => boolean,
): LaneOrphans {
  const byLane = new Map<string, { databases: string[]; live: boolean }>();
  const unowned: string[] = [];

  for (const row of rows) {
    if (LANE_ZERO_DATABASES.has(row.name)) continue;
    const stamp = parseLaneComment(row.comment);
    if (!stamp.lane) {
      unowned.push(row.name);
      continue;
    }
    if (stamp.lane === 'main') continue;
    const entry = byLane.get(stamp.lane) ?? { databases: [], live: false };
    entry.databases.push(row.name);
    // No root recorded is not evidence the worktree is gone.
    if (!stamp.root || exists(stamp.root)) entry.live = true;
    byLane.set(stamp.lane, entry);
  }

  const orphans = [...byLane]
    .filter(([, entry]) => !entry.live)
    .map(([lane, entry]) => ({ lane, databases: [...entry.databases].sort() }))
    .sort((a, b) => a.lane.localeCompare(b.lane));
  return { orphans, unowned: unowned.sort() };
}
