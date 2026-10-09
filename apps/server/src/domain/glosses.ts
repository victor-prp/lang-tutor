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
