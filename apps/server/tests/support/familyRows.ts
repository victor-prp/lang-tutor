import { and, asc, eq } from 'drizzle-orm';

import type { Db } from '../../src/db/client';
import { glossFamilies, glossFamilyEvents, glossFamilyMembers, vocabularyEntries } from '../../src/db/schema';

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
      // Phase 46 (spec D3): a member's known_at is its gloss's own.
      knownAt: vocabularyEntries.knownAt,
    })
    .from(glossFamilyMembers)
    .innerJoin(glossFamilies, eq(glossFamilies.id, glossFamilyMembers.familyId))
    .innerJoin(
      vocabularyEntries,
      and(eq(vocabularyEntries.enrollmentId, glossFamilyMembers.enrollmentId), eq(vocabularyEntries.glossId, glossFamilyMembers.glossId)),
    )
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
