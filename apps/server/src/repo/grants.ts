import type { Grant } from '@lang-tutor/core/api';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { Tx } from '../db/client';
import { enrollmentGrants, enrollments, users } from '../db/schema';
import type { GrantView } from '../domain/access';
import { GrantExists } from '../errors';
import { isUniqueViolation } from './pgErrors';

const owner = alias(users, 'owner');
const grantee = alias(users, 'grantee');

/** Every grant read joins its enrollment and both parties, so the wire shape is
 *  built in one place. */
function selectGrants(tx: Tx) {
  return tx
    .select({
      id: enrollmentGrants.id,
      role: enrollmentGrants.role,
      acceptedAt: enrollmentGrants.acceptedAt,
      createdAt: enrollmentGrants.createdAt,
      enrollmentId: enrollments.id,
      sourceLanguage: enrollments.sourceLanguage,
      targetLanguage: enrollments.targetLanguage,
      ownerId: owner.id,
      ownerUsername: owner.username,
      ownerDisplayName: owner.displayName,
      granteeId: grantee.id,
      granteeUsername: grantee.username,
      granteeDisplayName: grantee.displayName,
    })
    .from(enrollmentGrants)
    .innerJoin(enrollments, eq(enrollments.id, enrollmentGrants.enrollmentId))
    .innerJoin(owner, eq(owner.id, enrollmentGrants.ownerUserId))
    .innerJoin(grantee, eq(grantee.id, enrollmentGrants.granteeUserId));
}

type GrantSelectRow = Awaited<ReturnType<typeof selectGrants>>[number];

function toGrant(row: GrantSelectRow): Grant {
  return {
    id: row.id,
    role: row.role,
    status: row.acceptedAt ? 'accepted' : 'pending',
    enrollment: { id: row.enrollmentId, source_language: row.sourceLanguage, target_language: row.targetLanguage },
    owner: { id: row.ownerId, username: row.ownerUsername, display_name: row.ownerDisplayName },
    grantee: { id: row.granteeId, username: row.granteeUsername, display_name: row.granteeDisplayName },
    created_at: row.createdAt.toISOString(),
    accepted_at: row.acceptedAt ? row.acceptedAt.toISOString() : null,
  };
}

/**
 * Phase 28. The only reader and writer of enrollment_grants (ADR 0008 R1).
 * Primitives only (ADR 0001 R9): who may do what is domain/access.ts, and the
 * check is services/access.ts.
 */
export function createGrantRepo(tx: Tx) {
  const findGrant = async (id: string): Promise<Grant | undefined> => {
    const [row] = await selectGrants(tx).where(eq(enrollmentGrants.id, id));
    return row ? toGrant(row) : undefined;
  };

  return {
    /** Inserts optimistically and lets the unique key decide, as insertEnrollment
     *  does: a check-then-insert races a double tap. */
    insertGrant: async (input: {
      enrollmentId: string;
      ownerUserId: string;
      granteeUserId: string;
      role: string;
    }): Promise<Grant> => {
      let id: string;
      try {
        const [row] = await tx
          .insert(enrollmentGrants)
          .values({
            enrollmentId: input.enrollmentId,
            ownerUserId: input.ownerUserId,
            granteeUserId: input.granteeUserId,
            role: input.role,
          })
          .returning({ id: enrollmentGrants.id });
        id = row.id;
      } catch (error) {
        if (isUniqueViolation(error)) throw new GrantExists(input.enrollmentId, input.granteeUserId);
        throw error;
      }
      return (await findGrant(id))!;
    },

    findGrant,

    /** What authorize() needs: the actor's own grant on one list, if any. Served by
     *  enrollment_grants_enrollment_grantee_key. */
    findGrantFor: async (input: { enrollmentId: string; granteeUserId: string }): Promise<GrantView | null> => {
      const [row] = await tx
        .select({
          ownerUserId: enrollmentGrants.ownerUserId,
          granteeUserId: enrollmentGrants.granteeUserId,
          role: enrollmentGrants.role,
          acceptedAt: enrollmentGrants.acceptedAt,
        })
        .from(enrollmentGrants)
        .where(
          and(
            eq(enrollmentGrants.enrollmentId, input.enrollmentId),
            eq(enrollmentGrants.granteeUserId, input.granteeUserId),
          ),
        );
      return row
        ? {
            ownerUserId: row.ownerUserId,
            granteeUserId: row.granteeUserId,
            role: row.role,
            accepted: row.acceptedAt !== null,
          }
        : null;
    },

    /** Sets accepted_at once. A second accept finds no pending row and changes
     *  nothing, so a double tap keeps the first time. */
    acceptGrant: async (id: string): Promise<void> => {
      await tx
        .update(enrollmentGrants)
        .set({ acceptedAt: sql`now()` })
        .where(and(eq(enrollmentGrants.id, id), isNull(enrollmentGrants.acceptedAt)));
    },

    deleteGrant: async (id: string): Promise<void> => {
      await tx.delete(enrollmentGrants).where(eq(enrollmentGrants.id, id));
    },

    listForOwner: async (userId: string): Promise<Grant[]> =>
      (
        await selectGrants(tx)
          .where(eq(enrollmentGrants.ownerUserId, userId))
          .orderBy(desc(enrollmentGrants.createdAt), desc(enrollmentGrants.id))
      ).map(toGrant),

    listForGrantee: async (userId: string): Promise<Grant[]> =>
      (
        await selectGrants(tx)
          .where(eq(enrollmentGrants.granteeUserId, userId))
          .orderBy(desc(enrollmentGrants.createdAt), desc(enrollmentGrants.id))
      ).map(toGrant),
  };
}

export type GrantRepo = ReturnType<typeof createGrantRepo>;
