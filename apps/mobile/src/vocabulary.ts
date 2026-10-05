import type {
  TranslationSense,
  VocabularyEntryInput,
  VocabularyWord,
  VocabularyWordDetail,
} from '@lang-tutor/core/api';

/** sense_id → saved, for the senses the server said can be saved here. A sense
 *  absent from the map gets no toggle: a reverse lookup, a sentence, a failed
 *  write. The server decides; the screen only reads this. */
export type SavedState = Record<string, boolean>;

export function savedStateOf(senses: TranslationSense[]): SavedState {
  const state: SavedState = {};
  for (const sense of senses) {
    if (sense.sense_id && sense.variant_id && sense.saved !== undefined) state[sense.sense_id] = sense.saved;
  }
  return state;
}

export function unsavedEntries(senses: TranslationSense[], saved: SavedState): VocabularyEntryInput[] {
  return senses.flatMap((sense) =>
    sense.sense_id && sense.variant_id && saved[sense.sense_id] === false
      ? [{ sense_id: sense.sense_id, variant_id: sense.variant_id }]
      : [],
  );
}

/** Save-all from two: with one unsaved sense it would only repeat that card's button. */
export function canSaveAll(senses: TranslationSense[], saved: SavedState): boolean {
  return unsavedEntries(senses, saved).length >= 2;
}

/** The sense `flip` moves into the box: the top-ranked one, the card wearing the badge. */
export function topSense(senses: TranslationSense[]): TranslationSense | undefined {
  return senses[0];
}

/** A copy of `state` with every id in `ids` set to `value`; other entries and the input are untouched. */
export function withSaved(state: SavedState, ids: string[], value: boolean): SavedState {
  const next = { ...state };
  for (const id of ids) next[id] = value;
  return next;
}

export interface OptimisticToggle {
  /** The state to show now: true = saved. */
  next: boolean;
  /** Show a saved state (called with `next` first, and with `!next` on failure). */
  apply: (saved: boolean) => void;
  /** Mark the request in flight (true) and settled (false). */
  inFlight: (pending: boolean) => void;
  request: () => Promise<unknown>;
}

/** Flip first, revert on failure. Resolves to whether the request succeeded; never rejects.
 *  Shared by the translate screen and the drill-down so neither repeats the
 *  flip/pending/revert block. */
export async function toggleOptimistically(toggle: OptimisticToggle): Promise<boolean> {
  toggle.apply(toggle.next);
  toggle.inFlight(true);
  try {
    await toggle.request();
    return true;
  } catch {
    toggle.apply(!toggle.next);
    return false;
  } finally {
    toggle.inFlight(false);
  }
}

/** A word can move to the top between pages and be served on a refresh while an
 *  older copy is loaded. Under the newest sort the server never serves one twice
 *  in a walk, but a refresh racing a scroll can. Under a level sort a word whose
 *  level changes mid-walk may be served again, or passed over; dropping repeats
 *  by lexeme id makes the first harmless. The first copy stays. */
export function appendPage(loaded: VocabularyWord[], page: VocabularyWord[]): VocabularyWord[] {
  const seen = new Set(loaded.map((word) => word.lexeme_id));
  return [...loaded, ...page.filter((word) => !seen.has(word.lexeme_id))];
}

/** A word read again after a toggle, in the order the screen already shows. The
 *  server lists saved senses first, so taking its order would move the sense just
 *  tapped out from under the learner's finger. A sense new to the screen goes
 *  last; one the server no longer lists is dropped. */
export function keepSenseOrder(shown: VocabularyWordDetail, fresh: VocabularyWordDetail): VocabularyWordDetail {
  const position = new Map(shown.senses.map((sense, i) => [sense.sense_id, i]));
  const at = (senseId: string) => position.get(senseId) ?? shown.senses.length;
  return { ...fresh, senses: [...fresh.senses].sort((a, b) => at(a.sense_id) - at(b.sense_id)) };
}

export function showsMark(word: VocabularyWord): boolean {
  return word.sense_count > 1;
}
