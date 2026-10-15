import type {
  AddTargetWordsRequest,
  ChangeTargetDateRequest,
  CreateTargetRequest,
  TargetKind,
  TranslationResponse,
  TranslationSense,
  VocabularyEntryInput,
} from '@lang-tutor/core/api';

import { ApiError } from '@/api/client';
import type { Photo } from '@/photos';
import type { SavedState } from '@/vocabulary';

/**
 * Phase 53 (spec D10). The target wizard's state, as a reducer the screens only dispatch
 * into: which steps a mode has, what each step needs before it may go on, and the one
 * request Done sends. Nothing is saved until Done, so everything the learner picks
 * is held here, and the uploads and the request are the screen's.
 */

/** The most photos one request carries (`photo_import_ids`) and the most typed words
 *  (`entries`), the limits of the server's TargetWordsInputSchema. The wizard holds no
 *  more: a request over either is refused whole, at Done, after the learner has done
 *  the picking. */
export const MAX_PHOTOS = 10;
export const MAX_ENTRIES = 50;

/** `create` is New on home; the other three are a target screen's actions. */
export type WizardMode = 'create' | 'add-photos' | 'add-words' | 'change-date';
export type WizardStep = 'kind' | 'photos' | 'review' | 'words' | 'date';

const STEPS: Record<WizardMode, readonly WizardStep[]> = {
  create: ['kind', 'photos', 'review', 'words', 'date'],
  'add-photos': ['photos', 'review'],
  'add-words': ['words'],
  'change-date': ['date'],
};

/** The steps of a mode in order. The last is where Done is. */
export function stepsFor(mode: WizardMode): WizardStep[] {
  return [...STEPS[mode]];
}

const MODES = Object.keys(STEPS) as WizardMode[];
type RouteParam = string | string[] | undefined;

/** A new target, or one of a target's actions with the target it acts on. */
export type WizardRoute =
  | { mode: 'create'; targetId: null }
  | { mode: Exclude<WizardMode, 'create'>; targetId: string };

/**
 * What the wizard's route asks for. `/targets/new` alone is a new target; a target
 * screen's actions add their `mode` and the `targetId` they act on. An unknown mode is a
 * new target, and an action with no target to act on is nothing (null): the screen
 * leaves. A repeated parameter (an array) is no answer.
 */
export function wizardRouteOf(params: { mode?: RouteParam; targetId?: RouteParam }): WizardRoute | null {
  const mode = MODES.find((candidate) => candidate === params.mode) ?? 'create';
  if (mode === 'create') return { mode, targetId: null };
  const { targetId } = params;
  return typeof targetId === 'string' && targetId.length > 0 ? { mode, targetId } : null;
}

/** A word picked in the lookup: what the request needs, and what the wizard shows of it
 *  (ruling R-D11: the form it was looked up as, and the gloss's key). */
export type PickedEntry = { gloss_id: string; variant_id: string; form: string; meaning: string };

export type WizardState = {
  mode: WizardMode;
  step: WizardStep;
  kind: TargetKind | null;
  /** The photos taken or chosen, in the order they were added. */
  photos: Photo[];
  /** The photo imports made of them: `importIds[i]` is the import of `photos[i]`, and
   *  the photos past `importIds.length` are not uploaded yet (see photosToUpload). */
  importIds: string[];
  entries: PickedEntry[];
  /** The due date chosen, `YYYY-MM-DD`. */
  dueOn: string | null;
};

export type WizardAction =
  | { type: 'kind'; kind: TargetKind }
  /** Adds photos after the ones held, up to MAX_PHOTOS. */
  | { type: 'photos'; photos: Photo[] }
  | { type: 'remove-photo'; index: number }
  /** Every import made so far, in photo order: this replaces the ids held. */
  | { type: 'uploaded'; importIds: string[] }
  /** Picks a word, or picks it out again; a word is known by its gloss. */
  | { type: 'toggle-entry'; entry: PickedEntry }
  | { type: 'date'; dueOn: string }
  | { type: 'next' }
  | { type: 'back' };

export function initialWizard(mode: WizardMode): WizardState {
  return { mode, step: STEPS[mode][0], kind: null, photos: [], importIds: [], entries: [], dueOn: null };
}

/** The step `delta` away. The review is passed over when there are no photos to review,
 *  going back as well as on, so it is never landed on empty. At either end the step is
 *  the one it is. */
function move(state: WizardState, delta: 1 | -1): WizardStep {
  const steps = STEPS[state.mode];
  let index = steps.indexOf(state.step) + delta;
  while (steps[index] === 'review' && state.photos.length === 0) index += delta;
  return steps[index] ?? state.step;
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'kind':
      return { ...state, kind: action.kind };
    case 'photos':
      return { ...state, photos: [...state.photos, ...action.photos].slice(0, MAX_PHOTOS) };
    case 'remove-photo': {
      if (action.index < 0 || action.index >= state.photos.length) return state;
      // The import of the photo goes with it, or every import after it would belong to
      // the photo before it. (The screen discards that import on the server first.)
      return {
        ...state,
        photos: state.photos.filter((_, index) => index !== action.index),
        importIds: state.importIds.filter((_, index) => index !== action.index),
      };
    }
    case 'uploaded':
      return { ...state, importIds: [...action.importIds] };
    case 'toggle-entry': {
      const glossId = action.entry.gloss_id;
      if (state.entries.some((entry) => entry.gloss_id === glossId)) {
        return { ...state, entries: state.entries.filter((entry) => entry.gloss_id !== glossId) };
      }
      if (state.entries.length >= MAX_ENTRIES) return state;
      return { ...state, entries: [...state.entries, action.entry] };
    }
    case 'date':
      return { ...state, dueOn: action.dueOn };
    case 'next':
      return { ...state, step: move(state, 1) };
    case 'back':
      return { ...state, step: move(state, -1) };
  }
}

/** The photos still to upload: those past the ones that have an import. Going back from
 *  the review to the photos and on again finds none, so nothing is read twice, and a
 *  photo added meanwhile is the only one sent. */
export function photosToUpload(state: WizardState): Photo[] {
  return state.photos.slice(state.importIds.length);
}

/** Whether the step on screen is its mode's first: back from it leaves the wizard. */
export function isFirstStep(state: WizardState): boolean {
  return STEPS[state.mode][0] === state.step;
}

/** Whether the step on screen is its mode's last, where Done is instead of Next. */
export function isLastStep(state: WizardState): boolean {
  const steps = STEPS[state.mode];
  return steps[steps.length - 1] === state.step;
}

/** Whether the wizard holds photos or words, which leaving it loses: nothing is saved
 *  until Done, so leaving with them asks first. */
export function holdsPicks(state: WizardState): boolean {
  return state.photos.length > 0 || state.entries.length > 0;
}

/** Whether the wizard holds as many photos as a request carries: Take and Choose stop. */
export function photosFull(state: WizardState): boolean {
  return state.photos.length >= MAX_PHOTOS;
}

/** Whether the wizard holds as many words as a request carries: a card adds no more. */
export function entriesFull(state: WizardState): boolean {
  return state.entries.length >= MAX_ENTRIES;
}

/** Whether a word is picked, known by its gloss: the lookup's collect mode reads a
 *  card's state from it. */
export function holdsEntry(state: WizardState, glossId: string): boolean {
  return state.entries.some((entry) => entry.gloss_id === glossId);
}

/**
 * Whether a removed photo may go after the discard of its import failed. A 404 or a 409
 * is the server saying the import is gone or saved, so nothing is left behind. Anything
 * else (no answer, a server error) may have left it open, so the photo stays, its
 * import with it, for another try: dropping the photo would drop the only record of an
 * import Cancel must discard.
 */
export function discardLeftNothing(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 409);
}

/**
 * Whether the step on screen may go on (on the last step: whether Done may be pressed).
 * `reviewSettled` is the review's own answer, that every import it shows has been read
 * or has failed, which only the screen that polls them knows.
 *
 * A new target's photos and typed words are each optional, but the target needs a word
 * from one or the other, so the words step, the last chance to type one, asks for it
 * (ruling R-D10). Whether the photos yielded any is for the server to say.
 */
export function canAdvance(state: WizardState, reviewSettled: boolean): boolean {
  switch (state.step) {
    case 'kind':
      return state.kind !== null;
    case 'photos':
      return state.mode !== 'add-photos' || state.photos.length > 0;
    case 'review':
      return reviewSettled;
    case 'words':
      return state.entries.length > 0 || state.importIds.length > 0;
    case 'date':
      return state.dueOn !== null;
  }
}

const entriesOf = (entries: readonly PickedEntry[]): VocabularyEntryInput[] =>
  entries.map(({ gloss_id, variant_id }) => ({ gloss_id, variant_id }));

/** Done in `create`. Throws when the kind or the date was never chosen: `canAdvance`
 *  does not let the screen get there without them. */
export function createRequest(state: WizardState): CreateTargetRequest {
  if (state.kind === null) throw new Error('a new target needs a kind');
  if (state.dueOn === null) throw new Error('a new target needs a due date');
  return {
    kind: state.kind,
    due_on: state.dueOn,
    photo_import_ids: [...state.importIds],
    entries: entriesOf(state.entries),
  };
}

/** Done in `add-photos` and `add-words`. */
export function addRequest(state: WizardState): AddTargetWordsRequest {
  return { photo_import_ids: [...state.importIds], entries: entriesOf(state.entries) };
}

/** Done in `change-date`. Throws when no date was chosen, which `canAdvance` prevents. */
export function dateRequest(state: WizardState): ChangeTargetDateRequest {
  if (state.dueOn === null) throw new Error('a change of date needs a date');
  return { due_on: state.dueOn };
}

/**
 * What a lookup card adds to the wizard (the lookup's collect mode): the gloss and variant
 * the card saves, the word looked up, and the gloss's key as the meaning. The word is
 * the corrected form when the lookup corrected what was typed; the key is the card's `key`
 * when it differs from the rendering, and the rendering itself when it does not.
 * Null for a card with no ids, which cannot be added.
 */
export function pickedEntryOf(
  result: Pick<TranslationResponse, 'text' | 'correction'>,
  sense: TranslationSense,
): PickedEntry | null {
  if (!sense.gloss_id || !sense.variant_id) return null;
  return {
    gloss_id: sense.gloss_id,
    variant_id: sense.variant_id,
    form: result.correction?.corrected_form ?? result.text,
    meaning: sense.key ?? sense.translation,
  };
}

/** The lookup's save state with the wizard's answers in it: each card that can be added,
 *  and whether the wizard holds it. `saveable` says which cards those are (the server
 *  marks them), and what it says about them being saved is not read. */
export function pickedStateOf(saveable: SavedState, isPicked: (glossId: string) => boolean): SavedState {
  const state: SavedState = {};
  for (const glossId of Object.keys(saveable)) state[glossId] = isPicked(glossId);
  return state;
}

/** What "add all" picks: every card that can be added and is not picked yet, in card
 *  order, a gloss once. `picked` is pickedStateOf's answer. */
export function unpickedEntries(
  result: Pick<TranslationResponse, 'text' | 'correction' | 'senses'>,
  picked: SavedState,
): PickedEntry[] {
  const entries: PickedEntry[] = [];
  const seen = new Set<string>();
  for (const sense of result.senses) {
    const glossId = sense.gloss_id;
    if (!glossId || picked[glossId] !== false || seen.has(glossId)) continue;
    const entry = pickedEntryOf(result, sense);
    if (entry) {
      seen.add(glossId);
      entries.push(entry);
    }
  }
  return entries;
}
