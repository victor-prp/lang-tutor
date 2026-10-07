import type {
  TranslationSense,
  VocabularyEntryInput,
  VocabularyWord,
  VocabularyWordDetail,
} from '@lang-tutor/core/api';

import { strings } from '@/strings';

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

/** Phase 28 (spec D10). A tutor's lookup carries no enrollment, so the server
 *  marks nothing as saved: reading which senses the student has would be reading
 *  their list. Every sense with ids of a lookup FROM the student's target language
 *  can be added; a reverse lookup's senses belong to Hebrew lexemes and cannot. */
export function addableStateOf(senses: TranslationSense[], from: string, targetLanguage: string): SavedState {
  if (from !== targetLanguage) return {};
  const state: SavedState = {};
  for (const sense of senses) if (sense.sense_id && sense.variant_id) state[sense.sense_id] = false;
  return state;
}

/** Phase 28 (spec D10). The enrollment a lookup sends: only a learner's own. A
 *  tutor's lookup sends none, because the server would mark the student's saved
 *  senses for any enrollment id, which is reading their list. */
export const lookupEnrollmentId = (mode: 'learner' | 'tutor', enrollmentId: string): { enrollment_id?: string } =>
  mode === 'learner' ? { enrollment_id: enrollmentId } : {};

/** What tapping a card does: a tutor adds and never removes. */
export function toggleIntent(mode: 'learner' | 'tutor', saved: boolean): 'save' | 'unsave' | 'none' {
  if (!saved) return 'save';
  return mode === 'tutor' ? 'none' : 'unsave';
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
 *  older copy is loaded. The server never serves one twice in a walk, but a
 *  refresh racing a scroll can. Dropping repeats by lemma makes that harmless.
 *  The first copy stays. */
export function appendPage(loaded: VocabularyWord[], page: VocabularyWord[]): VocabularyWord[] {
  const seen = new Set(loaded.map((word) => word.lemma));
  return [...loaded, ...page.filter((word) => !seen.has(word.lemma))];
}

/** A row's parts of speech, named in Hebrew and joined: a merged word says it is
 *  merged. A code with no Hebrew name is left out rather than shown raw. */
export function partsOfSpeechLabel(codes: string[]): string {
  return codes
    .map((code) => strings.partOfSpeech(code))
    .filter((name): name is string => Boolean(name))
    .join(' · ');
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
