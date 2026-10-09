import { normaliseGloss } from '@lang-tutor/core/domain';

/**
 * Phase 31. The pure rules of glosses (spec D4–D7): how a stored translation
 * reads as one translation and its alternatives, which senses of one write share
 * a gloss, and how two glosses fold into one. No I/O (ADR 0001 R3).
 */

/** How many alternatives a rendering or a gloss keeps: enough for "also …" and
 *  the typed-meaning rule, few enough for one line on a card. */
export const MAX_GLOSS_ALTERNATIVES = 5;

const PARENTHETICAL = /\([^)]*\)/gu;
// The marks the photo import's glossesOf splits a printed translation on.
const LIST_MARKS = /[,/;]/u;

const tidy = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/**
 * Spec §2, migration step 2, and every write after it. The parentheticals go
 * first, so a comma or a slash inside one never splits: "אח (חבר, רע)" is אח.
 * What is left splits on the list marks; the first item is the translation and
 * the rest are its alternatives. Text that is nothing but a parenthetical stays
 * as it was, so a translation is never empty. 0024_glosses.sql holds the same
 * rule in SQL, and the migration test runs lane 0's shapes through both.
 */
export function splitTranslation(text: string): { translation: string; alternatives: string[] } {
  const items = text
    .replace(PARENTHETICAL, '')
    .split(LIST_MARKS)
    .map(tidy)
    .filter((item) => item.length > 0);
  if (items.length === 0) return { translation: tidy(text), alternatives: [] };
  const [translation, ...rest] = items;
  return { translation, alternatives: tidyGlossList(rest, translation) };
}

/** Distinct by normaliseGloss, never the main word, the first spelling kept, at
 *  most `cap`. */
export function tidyGlossList(items: readonly string[], main: string, cap = MAX_GLOSS_ALTERNATIVES): string[] {
  const seen = new Set([normaliseGloss(main)]);
  const kept: string[] = [];
  for (const raw of items) {
    const item = tidy(raw);
    const key = normaliseGloss(item);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    kept.push(item);
    if (kept.length === cap) break;
  }
  return kept;
}

/** One sense of one write, for one lexeme, in the order the answer ranked them. */
export type AnswerSense = { senseId: string; gloss: string; glossAlternatives: readonly string[] };

/** A live gloss of the lexeme in the write's learner language. */
export type LiveGloss = { id: string; key: string; alternatives: readonly string[] };

export type GlossPlan = {
  /** New glosses, each named by its lowest-ranked sense, with the senses that form it. */
  create: { key: string; alternatives: string[]; senseIds: string[] }[];
  /** Senses joining a gloss that already exists. */
  join: { senseId: string; glossId: string }[];
  /** Existing glosses whose alternatives grew: the whole new list. */
  alternatives: { glossId: string; alternatives: string[] }[];
  /** Spec D6: the lemma form's citation form renamed a gloss. */
  rename: { glossId: string; key: string }[];
  /** Spec D6, D7: a rename another gloss's key blocked. The merge job decides. */
  needsMerge: boolean;
};

/**
 * Spec D6 and D7, in their order. A sense with a membership keeps it: the first
 * rendering in a language decided, and a later form's different word stays on
 * its own rendering. Else it joins the live gloss whose key is equal once
 * normalised. Else senses of this write with one key share one new gloss,
 * spelled as the lowest-ranked wrote it. Only equal keys group: two senses that
 * name each other among their alternatives are a synonym merge, which is out.
 *
 * The senses with a membership go first and the new ones after, each group in
 * rank order, so every rename lands before a new sense looks for a gloss by
 * key: one answer never leaves the merge job a pair to fold (D7). A sense the
 * answer names twice counts once, as its first occurrence, so no gloss is
 * created that no membership points to.
 *
 * The lemma form may rename a gloss to its own citation form, and the gloss's
 * first member in this write, by rank, decides that alone. If its citation form
 * normalises differently from the key, the gloss is renamed when no other live
 * gloss holds that key; when one does, that is a merge, which this never does
 * (D7) and only asks for. If it agrees, the key stands. A later member never
 * renames the gloss, whatever it says: like any later form, it keeps its other
 * word on its own rendering (D6).
 */
export function assignGlosses(input: {
  senses: readonly AnswerSense[];
  lemmaForm: boolean;
  glosses: readonly LiveGloss[];
  memberships: ReadonlyMap<string, string>;
  /** A merged gloss's normalised key → its survivor's id: a sense that names a merged key joins the survivor (spec D7). */
  aliases?: ReadonlyMap<string, string>;
}): GlossPlan {
  // Working copies, so a rename made for one sense is what the next one joins.
  const byId = new Map(input.glosses.map((gloss) => [gloss.id, { ...gloss, alternatives: [...gloss.alternatives] }]));
  const byKey = new Map([...byId.values()].map((gloss) => [normaliseGloss(gloss.key), gloss.id]));
  const created = new Map<string, { key: string; alternatives: string[]; senseIds: string[] }>();
  const plan: GlossPlan = { create: [], join: [], alternatives: [], rename: [], needsMerge: false };
  // Glosses whose first member in this write has been seen: it alone decides.
  const decided = new Set<string>();
  const widened = new Set<string>();

  const widen = (glossId: string, extra: readonly string[]) => {
    const gloss = byId.get(glossId)!;
    const next = tidyGlossList([...gloss.alternatives, ...extra], gloss.key);
    if (next.length !== gloss.alternatives.length || next.some((item, i) => item !== gloss.alternatives[i])) {
      gloss.alternatives = next;
      widened.add(glossId);
    }
  };

  const firsts = new Map<string, AnswerSense>();
  for (const sense of input.senses) if (!firsts.has(sense.senseId)) firsts.set(sense.senseId, sense);
  const senses = [...firsts.values()];

  for (const sense of senses.filter(({ senseId }) => input.memberships.has(senseId))) {
    const glossId = input.memberships.get(sense.senseId)!;
    const gloss = byId.get(glossId);
    if (!gloss) continue;
    if (input.lemmaForm && !decided.has(glossId)) {
      decided.add(glossId);
      const key = normaliseGloss(sense.gloss);
      if (key !== normaliseGloss(gloss.key)) {
        const holder = byKey.get(key);
        if (holder === undefined) {
          byKey.delete(normaliseGloss(gloss.key));
          byKey.set(key, glossId);
          gloss.key = sense.gloss;
          plan.rename.push({ glossId, key: sense.gloss });
        } else {
          plan.needsMerge = true;
        }
      }
    }
    widen(glossId, sense.glossAlternatives);
  }

  for (const sense of senses.filter(({ senseId }) => !input.memberships.has(senseId))) {
    const key = normaliseGloss(sense.gloss);
    const existing = byKey.get(key) ?? input.aliases?.get(key);
    if (existing !== undefined) {
      plan.join.push({ senseId: sense.senseId, glossId: existing });
      widen(existing, sense.glossAlternatives);
      continue;
    }
    const fresh = created.get(key);
    if (fresh) {
      fresh.senseIds.push(sense.senseId);
      fresh.alternatives = tidyGlossList([...fresh.alternatives, ...sense.glossAlternatives], fresh.key);
      continue;
    }
    created.set(key, {
      key: sense.gloss,
      alternatives: tidyGlossList(sense.glossAlternatives, sense.gloss),
      senseIds: [sense.senseId],
    });
  }

  plan.create = [...created.values()];
  plan.alternatives = [...widened].map((glossId) => ({ glossId, alternatives: byId.get(glossId)!.alternatives }));
  return plan;
}

/** One progress row's state, as a merge folds it. Dates are `YYYY-MM-DD`. */
export type LevelState = { level: number; lastStepOn: string | null; lastWrongOn: string | null };

const later = (a: string | null, b: string | null): string | null =>
  a === null ? b : b === null ? a : a > b ? a : b;

/** Spec D3, done-means 4: two rows of one dimension folded into one, the higher
 *  level with the later of each date. 0025_glosses_rekey.sql holds the same rule. */
export function mergeLevels(a: LevelState, b: LevelState): LevelState {
  return {
    level: Math.max(a.level, b.level),
    lastStepOn: later(a.lastStepOn, b.lastStepOn),
    lastWrongOn: later(a.lastWrongOn, b.lastWrongOn),
  };
}

/** One session's snapshot of one dimension. */
export type SnapshotLevels = { levelBefore: number; levelAfter: number };

/** Two snapshot rows of one session and dimension folded: the lowest level before
 *  and the highest after, which keeps session_progress_levels_valid true. */
export function mergeSnapshots(a: SnapshotLevels, b: SnapshotLevels): SnapshotLevels {
  return { levelBefore: Math.min(a.levelBefore, b.levelBefore), levelAfter: Math.max(a.levelAfter, b.levelAfter) };
}

/** One saved entry, as a merge compares it. `savedAt` is a fixed-width UTC
 *  timestamp, `YYYY-MM-DDTHH:MI:SS.US`, so text order is time order. */
export type SavedState = { variantId: string; addedByUserId: string; savedAt: string };

/** Spec §3, the merge's entry rule: of two saves of one gloss, the earlier stays,
 *  with its form and its adder. */
export function keptEntry(a: SavedState, b: SavedState): SavedState {
  return b.savedAt < a.savedAt ? b : a;
}
