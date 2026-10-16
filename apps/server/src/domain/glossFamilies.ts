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
  /** When a refresh first saw it known (D2, D4); null if never. Phase 46 (spec D3):
   *  the gloss's own vocabulary_entries.known_at, family or not. */
  knownAt: string | null;
};

export type FamilyInput = {
  saved: readonly FamilyGloss[];
  /** Phase 46 (spec D1): `reachedOn`, the day the skill first reached KNOWN_STABILITY. */
  memory: readonly { glossId: string; dimension: Dimension; state: MemoryState; reachedOn: string | null }[];
  /** The session's live skills, as chooseWords computes them. */
  live: readonly Dimension[];
};

export type GlossFamily = { glossIds: string[]; label: string };
export type FamilyState = 'known' | 'current' | 'waiting';
export type FamilyEvidence = {
  live: Dimension[];
  stability: Partial<Record<Dimension, number>>;
  /** Phase 46 (spec D5): the day each skill reached the bar, for those that have. */
  reached: Partial<Record<Dimension, string>>;
};
export type Families = {
  families: GlossFamily[];
  familyOf: ReadonlyMap<string, number>;
  state: ReadonlyMap<string, FamilyState>;
  newlyKnown: ReadonlySet<string>;
  introductions: ReadonlyMap<string, string[]>;
  /** Phase 60 (spec D1). The current gloss of every family with a known member, practised or
   *  not: a new meaning of a known word, which is never a ladder. */
  newMeanings: ReadonlySet<string>;
  evidence: ReadonlyMap<string, FamilyEvidence>;
};

type MemoryRow = FamilyInput['memory'][number];

/** Phase 39 (spec D2), phase 46 (spec D2). Every live skill has reached KNOWN_STABILITY:
 *  a reachedOn, or stability at the bar now; speaking only when speakable. */
export function knownNow(
  glossId: string,
  speakable: boolean,
  memory: FamilyInput['memory'],
  live: readonly Dimension[],
): boolean {
  return knownFrom(speakable, memory.filter((m) => m.glossId === glossId), live);
}

/** knownNow over one gloss's own memory rows. */
function knownFrom(speakable: boolean, rows: readonly MemoryRow[], live: readonly Dimension[]): boolean {
  return live.every((d) => {
    if (d === 'spoken_productive' && !speakable) return true;
    return rows.some((m) => m.dimension === d && (m.reachedOn !== null || m.state.stability >= KNOWN_STABILITY));
  });
}

/**
 * Phase 39 (spec D1-D3). Groups a learner's saved glosses into families (same lexeme or a
 * shared variant spelling, transitively), and says which member of each is known, current
 * or waiting. Phase 46 (spec D2, D3): `newlyKnown` covers every saved gloss, family or not.
 * Pure (ADR 0001 R3).
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

  // Each gloss's memory rows, grouped once: the members below look theirs up.
  const rowsOf = new Map<string, MemoryRow[]>();
  for (const m of memory) {
    const rows = rowsOf.get(m.glossId);
    if (rows) rows.push(m);
    else rowsOf.set(m.glossId, [m]);
  }
  const practised: ReadonlySet<string> = new Set(rowsOf.keys());
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
  // Phase 46 (spec D3): every saved gloss, in a family or not, is stamped known
  // the first time it is.
  const newlyKnown = new Set<string>();
  for (const g of saved) {
    if (g.knownAt === null && knownFrom(g.speakable, rowsOf.get(g.glossId) ?? [], live)) newlyKnown.add(g.glossId);
  }
  const introductions = new Map<string, string[]>();
  const newMeanings = new Set<string>();
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
      const rows = rowsOf.get(g.glossId) ?? [];
      const stability: Partial<Record<Dimension, number>> = {};
      const reached: Partial<Record<Dimension, string>> = {};
      for (const r of rows) {
        stability[r.dimension] = r.state.stability;
        if (r.reachedOn !== null) reached[r.dimension] = r.reachedOn;
      }
      evidence.set(g.glossId, { live: [...live], stability, reached });

      if (g.knownAt !== null || newlyKnown.has(g.glossId)) known.add(g.glossId);
    }

    let current: FamilyGloss | undefined;
    for (const g of members) {
      if (known.has(g.glossId)) state.set(g.glossId, 'known');
      else if (!current) {
        current = g;
        state.set(g.glossId, 'current');
      } else state.set(g.glossId, 'waiting');
    }

    if (current && known.size >= 1) newMeanings.add(current.glossId);
    if (current && !practised.has(current.glossId) && known.size >= 1) {
      introductions.set(
        current.glossId,
        members.filter((g) => known.has(g.glossId)).map((g) => g.key),
      );
    }
  }

  return { families, familyOf, state, newlyKnown, introductions, newMeanings, evidence };
}
