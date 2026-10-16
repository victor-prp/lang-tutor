import { sql, type SQL } from 'drizzle-orm';

/**
 * Phase 57. A timestamptz as fixed-width UTC text to the microsecond,
 * '2026-10-16T09:30:00.123456Z': two such texts compare as strings exactly as the instants do,
 * which a Date (milliseconds) cannot, nor Postgres' own text (its session zone, trailing zeros
 * trimmed). The session-end write compares an answer's time with its word's joining a target
 * in the domain, so both are read this way.
 */
export const instantText = (column: SQL): SQL<string> =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
