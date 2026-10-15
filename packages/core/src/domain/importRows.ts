/**
 * Phase 53 (ruling R-D9). Each photo is its own photo import, and the rows of several are
 * reviewed and saved as one list, in import order and then position. Rows that resolve to the
 * same gloss are one row: the first decides, and a later one is not shown, ticked or saved.
 * A row whose gloss is null (not looked up yet, or failed) is always kept, since it is no
 * gloss's yet. One rule for both sides of the wire: the app's review shows what this keeps,
 * and the server's save takes what this keeps, so the two cannot disagree.
 */
export function firstRowPerGloss<T>(rows: readonly T[], glossOf: (row: T) => string | null): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const gloss = glossOf(row);
    if (gloss === null) return true;
    if (seen.has(gloss)) return false;
    seen.add(gloss);
    return true;
  });
}
