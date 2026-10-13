import type { Dimension } from '@lang-tutor/core/domain';

import { KNOWN_STABILITY } from './chooseConstants';
import type { Families, FamilyState } from './glossFamilies';

/** Phase 39 (spec D4). A stored family as the refresh reads it. repo/glossFamilies'
 *  StoredFamily satisfies it; the domain declares its own (ADR 0001 R3). */
export type StoredFamilyView = {
  id: string;
  label: string;
  createdAt: string;
  members: readonly { glossId: string; familyId: string; state: FamilyState; position: number }[];
};

/** Phase 39 (spec D4). Why a member is where it is: the session's live skills, its
 *  stability in each, the day each reached the bar (phase 46 D5), and the bar. Empty
 *  for a member that left: its family went, not its memory. */
export type FamilyEventEvidence =
  | {
      live: Dimension[];
      stability: Partial<Record<Dimension, number>>;
      reached: Partial<Record<Dimension, string>>;
      known_stability: number;
    }
  | Record<string, never>;

/** Phase 39 (spec D4). One refresh's writes, in the shape repo/glossFamilies' apply takes. */
export type FamilyWrite = {
  /** Upserted: new families, and kept ones whose label or members changed. A new
   *  family's id is a placeholder (`new:<index>`) its members and events carry too;
   *  the repo creates the real id (ADR 0002: the domain draws no randomness). */
  families: { id: string; label: string; isNew: boolean }[];
  deleteFamilies: string[];
  /** Upserted; `since` moves only when `sinceChanged`. Phase 46 (spec D3): known_at is the
   *  gloss's own (vocabulary_entries), not the member's. */
  members: { glossId: string; familyId: string; state: FamilyState; position: number; sinceChanged: boolean }[];
  /** Gloss ids. */
  deleteMembers: string[];
  /** `fromState` null: joined the family; `toState` null: left it. */
  events: { familyId: string; glossId: string; fromState: FamilyState | null; toState: FamilyState | null; evidence: FamilyEventEvidence }[];
};

/**
 * Phase 39 (spec D4). What to write so the tables show `computed`. A computed family
 * keeps the id of the stored family holding most of its members (ties: the older,
 * created first); one with no stored members gets the placeholder `new:<index>`,
 * which apply turns into a real id. A stored family left with none is deleted.
 * Every change of state or family is one event with the member's evidence; a
 * member joining a family, a merge's included, is `joined`. Phase 46 (spec D3): a gloss's
 * known_at is stamped on the gloss by the caller, not here. Pure.
 */
export function familyChanges(stored: readonly StoredFamilyView[], computed: Families): FamilyWrite {
  const write: FamilyWrite = { families: [], deleteFamilies: [], members: [], deleteMembers: [], events: [] };
  const before = new Map(stored.flatMap((family) => family.members.map((member) => [member.glossId, member] as const)));

  // Family identity: the largest share of a stored family claims its id first.
  const shares = computed.families.flatMap((family, index) =>
    stored.flatMap((old) => {
      const count = old.members.filter((member) => computed.familyOf.get(member.glossId) === index).length;
      return count > 0 ? [{ index, old, count }] : [];
    }),
  );
  shares.sort(
    (a, b) =>
      b.count - a.count ||
      (a.old.createdAt < b.old.createdAt ? -1 : a.old.createdAt > b.old.createdAt ? 1 : 0) ||
      (a.old.id < b.old.id ? -1 : a.old.id > b.old.id ? 1 : 0) ||
      a.index - b.index,
  );
  const kept = new Map<number, StoredFamilyView>();
  const claimed = new Set<string>();
  for (const { index, old } of shares) {
    if (kept.has(index) || claimed.has(old.id)) continue;
    kept.set(index, old);
    claimed.add(old.id);
  }

  const evidenceOf = (glossId: string): FamilyEventEvidence => {
    const { live, stability, reached } = computed.evidence.get(glossId)!;
    return { live, stability, reached, known_stability: KNOWN_STABILITY };
  };
  // Families whose members changed: their updated_at moves.
  const touched = new Set<string>();

  const ids = computed.families.map((_, index) => kept.get(index)?.id ?? `new:${index}`);
  computed.families.forEach((family, index) => {
    const familyId = ids[index];
    family.glossIds.forEach((glossId, position) => {
      const state = computed.state.get(glossId)!;
      const old = before.get(glossId);
      // Null: it joined this family, new to the tables or from another family.
      const fromState = old?.familyId === familyId ? old.state : null;
      const changed = fromState !== state;
      if (!changed && old?.position === position) return;
      write.members.push({ glossId, familyId, state, position, sinceChanged: changed });
      touched.add(familyId);
      if (old && old.familyId !== familyId) touched.add(old.familyId);
      if (changed) write.events.push({ familyId, glossId, fromState, toState: state, evidence: evidenceOf(glossId) });
    });
  });

  for (const old of stored) {
    for (const member of old.members) {
      if (computed.familyOf.has(member.glossId)) continue;
      write.deleteMembers.push(member.glossId);
      write.events.push({ familyId: old.id, glossId: member.glossId, fromState: member.state, toState: null, evidence: {} });
      touched.add(old.id);
    }
    if (!claimed.has(old.id)) write.deleteFamilies.push(old.id);
  }

  computed.families.forEach((family, index) => {
    const old = kept.get(index);
    if (!old || old.label !== family.label || touched.has(ids[index])) {
      write.families.push({ id: ids[index], label: family.label, isNew: !old });
    }
  });
  return write;
}

/** Phase 39 (spec D4). A refresh that changed nothing writes nothing. */
export function isEmptyFamilyWrite(write: FamilyWrite): boolean {
  return (
    write.families.length === 0 &&
    write.deleteFamilies.length === 0 &&
    write.members.length === 0 &&
    write.deleteMembers.length === 0 &&
    write.events.length === 0
  );
}
