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
 * as it was, so a translation is never empty. 0022_glosses.sql holds the same
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
 * The lemma form may rename its sense's gloss to its own citation form, once per
 * gloss per write, when no other live gloss holds that key; when one does, that
 * is a merge, which this never does (D7) and only asks for.
 */
export function assignGlosses(input: {
  senses: readonly AnswerSense[];
  lemmaForm: boolean;
  glosses: readonly LiveGloss[];
  memberships: ReadonlyMap<string, string>;
}): GlossPlan {
  // Working copies, so a rename made for one sense is what the next one joins.
  const byId = new Map(input.glosses.map((gloss) => [gloss.id, { ...gloss, alternatives: [...gloss.alternatives] }]));
  const byKey = new Map([...byId.values()].map((gloss) => [normaliseGloss(gloss.key), gloss.id]));
  const created = new Map<string, { key: string; alternatives: string[]; senseIds: string[] }>();
  const plan: GlossPlan = { create: [], join: [], alternatives: [], rename: [], needsMerge: false };
  const renamed = new Set<string>();
  const widened = new Set<string>();

  const widen = (glossId: string, extra: readonly string[]) => {
    const gloss = byId.get(glossId)!;
    const next = tidyGlossList([...gloss.alternatives, ...extra], gloss.key);
    if (next.length !== gloss.alternatives.length || next.some((item, i) => item !== gloss.alternatives[i])) {
      gloss.alternatives = next;
      widened.add(glossId);
    }
  };

  for (const sense of input.senses) {
    const key = normaliseGloss(sense.gloss);
    const current = input.memberships.get(sense.senseId);
    if (current !== undefined) {
      const gloss = byId.get(current);
      if (gloss) {
        if (input.lemmaForm && !renamed.has(current) && key !== normaliseGloss(gloss.key)) {
          const holder = byKey.get(key);
          if (holder === undefined && !created.has(key)) {
            byKey.delete(normaliseGloss(gloss.key));
            byKey.set(key, current);
            gloss.key = sense.gloss;
            renamed.add(current);
            plan.rename.push({ glossId: current, key: sense.gloss });
          } else if (holder !== current) {
            plan.needsMerge = true;
          }
        }
        widen(current, sense.glossAlternatives);
      }
      continue;
    }
    const existing = byKey.get(key);
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
