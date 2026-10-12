import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { glossFamilies, glossFamilyEvents, glossFamilyMembers } from '../db/schema';

export type StoredMember = {
  glossId: string;
  familyId: string;
  state: 'known' | 'current' | 'waiting';
  position: number;
  knownAt: string | null;
};
export type StoredFamily = { id: string; label: string; createdAt: string; members: StoredMember[] };
export type FamilyWrite = {
  /** Upserted. */
  families: { id: string; label: string; isNew: boolean }[];
  deleteFamilies: string[];
  /** Upserted; `since` moves only when `sinceChanged`. */
  members: { glossId: string; familyId: string; state: string; position: number; knownAt: string | null; sinceChanged: boolean }[];
  /** Gloss ids. */
  deleteMembers: string[];
  events: { familyId: string; glossId: string; fromState: string | null; toState: string | null; evidence: unknown }[];
};

/**
 * Phase 39 (spec D4). gloss_families, gloss_family_members and gloss_family_events:
 * what each session creation decided about the families of one enrollment.
 */
export function createGlossFamiliesRepo(tx: Tx) {
  return {
    /** The stored families with their members in position order, oldest family first. */
    load: async (enrollmentId: string): Promise<StoredFamily[]> => {
      const families = await tx
        .select()
        .from(glossFamilies)
        .where(eq(glossFamilies.enrollmentId, enrollmentId))
        .orderBy(asc(glossFamilies.createdAt), asc(glossFamilies.id));
      const members = await tx
        .select()
        .from(glossFamilyMembers)
        .where(eq(glossFamilyMembers.enrollmentId, enrollmentId))
        .orderBy(asc(glossFamilyMembers.familyId), asc(glossFamilyMembers.position), asc(glossFamilyMembers.glossId));
      return families.map((family) => ({
        id: family.id,
        label: family.label,
        createdAt: family.createdAt.toISOString(),
        members: members
          .filter((member) => member.familyId === family.id)
          .map((member) => ({
            glossId: member.glossId,
            familyId: member.familyId,
            state: member.state as StoredMember['state'],
            position: member.position,
            knownAt: member.knownAt ? member.knownAt.toISOString() : null,
          })),
      }));
    },

    /** Writes one refresh: families first (members reference them), members, then the log.
     *  Members leave before families go, so a family's delete cascades nothing the write
     *  still means to keep. */
    apply: async (enrollmentId: string, sessionId: string, write: FamilyWrite): Promise<void> => {
      for (const family of write.families) {
        await tx
          .insert(glossFamilies)
          .values({ id: family.id, enrollmentId, label: family.label })
          .onConflictDoUpdate({
            target: glossFamilies.id,
            set: { label: family.label, updatedAt: sql`now()` },
          });
      }
      if (write.deleteMembers.length > 0) {
        await tx
          .delete(glossFamilyMembers)
          .where(and(eq(glossFamilyMembers.enrollmentId, enrollmentId), inArray(glossFamilyMembers.glossId, write.deleteMembers)));
      }
      for (const member of write.members) {
        const set = {
          familyId: member.familyId,
          state: member.state,
          position: member.position,
          knownAt: member.knownAt === null ? null : new Date(member.knownAt),
          ...(member.sinceChanged ? { since: sql`now()` } : {}),
        };
        await tx
          .insert(glossFamilyMembers)
          .values({ enrollmentId, glossId: member.glossId, ...set, since: sql`now()` })
          .onConflictDoUpdate({ target: [glossFamilyMembers.enrollmentId, glossFamilyMembers.glossId], set });
      }
      if (write.deleteFamilies.length > 0) {
        await tx
          .delete(glossFamilies)
          .where(and(eq(glossFamilies.enrollmentId, enrollmentId), inArray(glossFamilies.id, write.deleteFamilies)));
      }
      if (write.events.length > 0) {
        await tx.insert(glossFamilyEvents).values(
          write.events.map((event) => ({
            id: sql<string>`gen_random_uuid()::text`,
            enrollmentId,
            familyId: event.familyId,
            glossId: event.glossId,
            sessionId,
            fromState: event.fromState,
            toState: event.toState,
            evidence: event.evidence ?? {},
            at: sql`now()`,
          })),
        );
      }
    },
  };
}

export type GlossFamiliesRepo = ReturnType<typeof createGlossFamiliesRepo>;
