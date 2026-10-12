import { asc, eq } from 'drizzle-orm';

import type { Db } from '../../src/db/client';
import { glossFamilies, glossFamilyEvents, glossFamilyMembers } from '../../src/db/schema';

/**
 * Phase 39 (spec D4). Reads of the recorded gloss families. tests/support/ is the
 * test composition root, so a service test reaches these tables only through here.
 */

/** Every member of one enrollment's families, with its family's label, in family
 *  label then position order; `knownAt` as an ISO string. */
export async function readFamilyMembers(db: Db, enrollmentId: string) {
  const rows = await db
    .select({
      familyId: glossFamilyMembers.familyId,
      label: glossFamilies.label,
      glossId: glossFamilyMembers.glossId,
      state: glossFamilyMembers.state,
      position: glossFamilyMembers.position,
      knownAt: glossFamilyMembers.knownAt,
    })
    .from(glossFamilyMembers)
    .innerJoin(glossFamilies, eq(glossFamilies.id, glossFamilyMembers.familyId))
    .where(eq(glossFamilyMembers.enrollmentId, enrollmentId))
    .orderBy(asc(glossFamilies.label), asc(glossFamilyMembers.position));
  return rows.map((row) => ({ ...row, knownAt: row.knownAt ? row.knownAt.toISOString() : null }));
}

/** Every event of one enrollment, oldest first. */
export async function readFamilyEvents(db: Db, enrollmentId: string) {
  return db
    .select({
      familyId: glossFamilyEvents.familyId,
      glossId: glossFamilyEvents.glossId,
      sessionId: glossFamilyEvents.sessionId,
      fromState: glossFamilyEvents.fromState,
      toState: glossFamilyEvents.toState,
      evidence: glossFamilyEvents.evidence,
    })
    .from(glossFamilyEvents)
    .where(eq(glossFamilyEvents.enrollmentId, enrollmentId))
    .orderBy(asc(glossFamilyEvents.at), asc(glossFamilyEvents.glossId));
}
