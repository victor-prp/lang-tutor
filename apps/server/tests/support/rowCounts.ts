import { sql } from 'drizzle-orm';

import type { Db } from '../../src/db/client';

/**
 * Phase 29 (spec D13). How many rows each named table holds. A refused use case
 * must leave every count as it found it; here, not in the test, because a
 * service test reaches the database only through tests/support.
 */
export async function countRows(db: Db, tables: readonly string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const result = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from ${sql.identifier(table)}`,
    );
    counts[table] = result.rows[0].count;
  }
  return counts;
}
