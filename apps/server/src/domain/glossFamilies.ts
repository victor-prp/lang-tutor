import type { Dimension, MemoryState } from '@lang-tutor/core/domain';

import { KNOWN_STABILITY } from './chooseConstants';

/** Phase 39 (spec D3). One saved gloss as the families rule reads it. */
export type FamilyGloss = {
  glossId: string;
  lexemeId: string;
  /** Its lexeme's lemma (vocabulary_entries.lemma): what a family's label is made of. */
  lemma: string;
  /** Its Hebrew meaning: what an intro card lists as known. */
  key: string;
  savedAt: string;
  /** Every variant spelling of its lexeme, lowercased (D1). */
  forms: readonly string[];
  /** [saved variant's entry_rank, lowest rendering rank on it]. Lower is more common. */
  order: readonly [number, number];
  /** One to four words: it can ever get speaking memory (D2). */
  speakable: boolean;
  /** When a refresh first saw it known (D2, D4); null if never. */
  knownAt: string | null;
};

export type FamilyInput = {
  saved: readonly FamilyGloss[];
  memory: readonly { glossId: string; dimension: Dimension; state: MemoryState }[];
  /** The session's live skills, as chooseWords computes them. */
  live: readonly Dimension[];
};

export type GlossFamily = { glossIds: string[]; label: string };
export type FamilyState = 'known' | 'current' | 'waiting';
export type FamilyEvidence = { live: Dimension[]; stability: Partial<Record<Dimension, number>> };
export type Families = {
  families: GlossFamily[];
  familyOf: ReadonlyMap<string, number>;
  state: ReadonlyMap<string, FamilyState>;
  newlyKnown: ReadonlySet<string>;
  introductions: ReadonlyMap<string, string[]>;
  evidence: ReadonlyMap<string, FamilyEvidence>;
};

/** Phase 39 (spec D2). Every live skill at KNOWN_STABILITY; speaking only when speakable. */
export function knownNow(
  glossId: string,
  speakable: boolean,
  memory: FamilyInput['memory'],
  live: readonly Dimension[],
): boolean {
  return live.every((d) => {
    if (d === 'spoken_productive' && !speakable) return true;
    return memory.some(
      (m) => m.glossId === glossId && m.dimension === d && m.state.stability >= KNOWN_STABILITY,
    );
  });
}

/**
 * Phase 39 (spec D1-D3). Groups a learner's saved glosses into families (same lexeme or a
 * shared variant spelling, transitively), and says which member of each is known, current
 * or waiting. Pure (ADR 0001 R3).
 */
export function glossFamilies(input: FamilyInput): Families {
  const { saved, memory, live } = input;

  // Union-find over saved glosses, by lexeme and by shared form.
  const parent = saved.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  const byLexeme = new Map<string, number>();
  const byForm = new Map<string, number>();
  saved.forEach((g, i) => {
    const l = byLexeme.get(g.lexemeId);
    if (l === undefined) byLexeme.set(g.lexemeId, i);
    else union(i, l);
    for (const f of g.forms) {
      const o = byForm.get(f);
      if (o === undefined) byForm.set(f, i);
      else union(i, o);
    }
  });

  const groups = new Map<number, FamilyGloss[]>();
  saved.forEach((g, i) => {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(g);
    else groups.set(root, [g]);
  });

  const practised = new Set(memory.map((m) => m.glossId));
  const compare = (a: FamilyGloss, b: FamilyGloss): number => {
    const pa = practised.has(a.glossId) ? 0 : 1;
    const pb = practised.has(b.glossId) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (a.order[0] !== b.order[0]) return a.order[0] - b.order[0];
    if (a.order[1] !== b.order[1]) return a.order[1] - b.order[1];
    if (a.savedAt !== b.savedAt) return a.savedAt < b.savedAt ? -1 : 1;
    return a.glossId < b.glossId ? -1 : a.glossId > b.glossId ? 1 : 0;
  };

  const families: GlossFamily[] = [];
  const familyOf = new Map<string, number>();
  const state = new Map<string, FamilyState>();
  const newlyKnown = new Set<string>();
  const introductions = new Map<string, string[]>();
  const evidence = new Map<string, FamilyEvidence>();

  const ordered = [...groups.values()]
    .filter((m) => m.length >= 2)
    .map((m) => m.sort(compare))
    .sort((a, b) => compare(a[0], b[0]));

  for (const members of ordered) {
    const index = families.length;
    const lemmas = [...new Set(members.map((g) => g.lemma))].sort();
    families.push({ glossIds: members.map((g) => g.glossId), label: lemmas.join(' / ') });

    const known = new Set<string>();
    for (const g of members) {
      familyOf.set(g.glossId, index);
      const rows = memory.filter((m) => m.glossId === g.glossId);
      const stability: Partial<Record<Dimension, number>> = {};
      for (const r of rows) stability[r.dimension] = r.state.stability;
      evidence.set(g.glossId, { live: [...live], stability });

      if (g.knownAt !== null) known.add(g.glossId);
      else if (knownNow(g.glossId, g.speakable, memory, live)) {
        known.add(g.glossId);
        newlyKnown.add(g.glossId);
      }
    }

    let current: FamilyGloss | undefined;
    for (const g of members) {
      if (known.has(g.glossId)) state.set(g.glossId, 'known');
      else if (!current) {
        current = g;
        state.set(g.glossId, 'current');
      } else state.set(g.glossId, 'waiting');
    }

    if (current && !practised.has(current.glossId) && known.size >= 1) {
      introductions.set(
        current.glossId,
        members.filter((g) => known.has(g.glossId)).map((g) => g.key),
      );
    }
  }

  return { families, familyOf, state, newlyKnown, introductions, evidence };
}
