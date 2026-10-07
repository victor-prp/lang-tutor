import { sql } from 'drizzle-orm';

import type { Db } from '../../src/db/client';

/**
 * A grant written directly. tests/support/ is the test composition root, so it
 * may name enrollment_grants (ADR 0008 R1 scans apps/server/src only). Tests
 * about what a grant ALLOWS need one without driving invite and accept.
 */
export async function seedGrant(
  db: Db,
  input: { id?: string; enrollmentId: string; ownerUserId: string; granteeUserId: string; accepted: boolean },
): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into enrollment_grants (id, enrollment_id, owner_user_id, grantee_user_id, role, accepted_at)
    values (coalesce(${input.id ?? null}, gen_random_uuid()::text), ${input.enrollmentId}, ${input.ownerUserId},
            ${input.granteeUserId}, 'tutor', ${input.accepted ? sql`now()` : sql`null`})
    returning id`);
  return rows.rows[0].id;
}
