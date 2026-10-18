import { describe, expect, it } from '@jest/globals';
import type { TranslationSense } from '@lang-tutor/core/api';

import { ApiError } from './api/client';
import type { Photo } from './photos';
import {
  MAX_ENTRIES,
  MAX_PHOTOS,
  addRequest,
  canAdvance,
  createRequest,
  dateRequest,
  discardImports,
  discardLeftNothing,
  entriesFull,
  holdsEntry,
  holdsPicks,
  initialWizard,
  isFirstStep,
  isLastStep,
  photosFull,
  photosToUpload,
  pickedEntryOf,
  pickedStateOf,
  saveHolding,
  stepsFor,
  unpickedEntries,
  wizardReducer,
  wizardRouteOf,
  type PickedEntry,
  type WizardAction,
  type WizardMode,
  type WizardState,
  type WizardStep,
} from './targetWizard';

const photo = (n: number): Photo => ({ base64: `P${n}`, mimeType: 'image/jpeg' });
const photos = (count: number): Photo[] => Array.from({ length: count }, (_, n) => photo(n));
const entry = (n: number): PickedEntry => ({
  gloss_id: `g${n}`,
  variant_id: `v${n}`,
  form: `form${n}`,
  meaning: `meaning${n}`,
});
const play = (state: WizardState, ...actions: WizardAction[]): WizardState => actions.reduce(wizardReducer, state);
// A wizard of `mode`, with what a test needs already chosen.
const at = (mode: WizardMode, over: Partial<WizardState> = {}): WizardState => ({ ...initialWizard(mode), ...over });

describe('stepsFor', () => {
  it('lists the steps of each mode, in order', () => {
    expect(stepsFor('photo')).toEqual(['photos', 'review', 'choose', 'words', 'date']);
    expect(stepsFor('add-words')).toEqual(['words']);
    expect(stepsFor('change-date')).toEqual(['date']);
  });

  it('hands out a copy, so a caller cannot change the steps of a mode', () => {
    stepsFor('photo').pop();
    expect(stepsFor('photo')).toHaveLength(5);
  });
});

describe('initialWizard', () => {
  it('starts every mode on its first step, with nothing chosen', () => {
    expect(initialWizard('photo')).toEqual({
      mode: 'photo',
      step: 'photos',
      destination: null,
      photos: [],
      importIds: [],
      entries: [],
      dueOn: null,
    });
    expect(initialWizard('add-words').step).toBe('words');
    expect(initialWizard('change-date').step).toBe('date');
  });

  it('shares no list between two wizards', () => {
    const [one, two] = [initialWizard('photo'), initialWizard('photo')];
    expect(one.photos).not.toBe(two.photos);
    expect(one.entries).not.toBe(two.entries);
    expect(one.importIds).not.toBe(two.importIds);
  });
});

describe('wizardReducer', () => {
  // Phase 64 (spec D8). What to do with the words, chosen after they are marked.
  describe('destination', () => {
    it('sets where the words go, and a later choice replaces it', () => {
      const state = play(initialWizard('photo'), { type: 'destination', destination: { kind: 'my-words' } });
      expect(state.destination).toEqual({ kind: 'my-words' });
      const target = { kind: 'target' as const, targetId: 't1' };
      expect(play(state, { type: 'destination', destination: target }).destination).toEqual(target);
    });
  });

  describe('photos', () => {
    it('adds photos after the ones held, in order', () => {
      const state = play(
        initialWizard('photo'),
        { type: 'photos', photos: [photo(1)] },
        { type: 'photos', photos: [photo(2), photo(3)] },
      );
      expect(state.photos).toEqual([photo(1), photo(2), photo(3)]);
    });

    it('holds no more photos than a request carries', () => {
      expect(MAX_PHOTOS).toBe(10);
      const state = play(
        initialWizard('photo'),
        { type: 'photos', photos: photos(8) },
        { type: 'photos', photos: [photo(8), photo(9), photo(10), photo(11), photo(12)] },
      );
      expect(state.photos).toEqual(photos(10));
      expect(play(state, { type: 'photos', photos: [photo(13)] }).photos).toEqual(photos(10));
    });
  });

  describe('remove-photo', () => {
    it('removes the photo at an index and leaves the others in order', () => {
      const state = play(at('photo', { photos: photos(3) }), { type: 'remove-photo', index: 1 });
      expect(state.photos).toEqual([photo(0), photo(2)]);
    });

    it('ignores an index with no photo', () => {
      const before = at('photo', { photos: photos(2) });
      expect(wizardReducer(before, { type: 'remove-photo', index: 2 })).toBe(before);
      expect(wizardReducer(before, { type: 'remove-photo', index: -1 })).toBe(before);
    });

    // importIds[i] is the import of photos[i]; a removed photo's import goes from
    // the list with it, or the next removal would drop the wrong photo's import.
    it("takes a removed photo's import with it, when it was uploaded", () => {
      const before = at('photo', { photos: photos(3), importIds: ['i0', 'i1'] });
      const first = wizardReducer(before, { type: 'remove-photo', index: 0 });
      expect(first.photos).toEqual([photo(1), photo(2)]);
      expect(first.importIds).toEqual(['i1']);
      // A photo not uploaded yet has no import to take.
      expect(wizardReducer(before, { type: 'remove-photo', index: 2 }).importIds).toEqual(['i0', 'i1']);
    });
  });

  describe('uploaded', () => {
    it('records the imports of the photos uploaded, in photo order', () => {
      const state = play(at('photo', { photos: photos(2) }), { type: 'uploaded', importIds: ['i0', 'i1'] });
      expect(state.importIds).toEqual(['i0', 'i1']);
    });

    it('replaces the imports it held, so the screen passes every one uploaded so far', () => {
      const state = play(
        at('photo', { photos: photos(3), importIds: ['i0'] }),
        { type: 'uploaded', importIds: ['i0', 'i1', 'i2'] },
      );
      expect(state.importIds).toEqual(['i0', 'i1', 'i2']);
    });
  });

  describe('toggle-entry', () => {
    it('picks a word, and picks it out again on a second toggle', () => {
      const picked = play(initialWizard('photo'), { type: 'toggle-entry', entry: entry(1) });
      expect(picked.entries).toEqual([entry(1)]);
      expect(play(picked, { type: 'toggle-entry', entry: entry(1) }).entries).toEqual([]);
    });

    it('knows a word by its gloss, whatever form it comes with', () => {
      const picked = play(initialWizard('photo'), { type: 'toggle-entry', entry: entry(1) });
      const again = { ...entry(1), form: 'another form', meaning: 'another meaning' };
      expect(play(picked, { type: 'toggle-entry', entry: again }).entries).toEqual([]);
    });

    it('keeps the words in the order they were picked', () => {
      const state = play(
        initialWizard('photo'),
        { type: 'toggle-entry', entry: entry(1) },
        { type: 'toggle-entry', entry: entry(2) },
        { type: 'toggle-entry', entry: entry(3) },
        { type: 'toggle-entry', entry: entry(2) },
      );
      expect(state.entries).toEqual([entry(1), entry(3)]);
    });

    it('holds no more words than a request carries, and still lets one go', () => {
      expect(MAX_ENTRIES).toBe(50);
      const full = at('photo', { entries: Array.from({ length: 50 }, (_, n) => entry(n)) });
      expect(play(full, { type: 'toggle-entry', entry: entry(50) }).entries).toHaveLength(50);
      expect(play(full, { type: 'toggle-entry', entry: entry(7) }).entries).toHaveLength(49);
    });
  });

  describe('date', () => {
    it('sets the due date, and a later choice replaces it', () => {
      const state = play(initialWizard('photo'), { type: 'date', dueOn: '2026-10-20' });
      expect(state.dueOn).toBe('2026-10-20');
      expect(play(state, { type: 'date', dueOn: '2026-10-22' }).dueOn).toBe('2026-10-22');
    });
  });

  describe('next and back', () => {
    // Photos held, so the review is not skipped.
    // A new target's photo flow walks every step; the others are their own.
    const modes: [WizardMode, WizardStep[]][] = [
      ['photo', ['photos', 'review', 'choose', 'words', 'date']],
      ['add-words', ['words']],
      ['change-date', ['date']],
    ];

    it.each(modes)('walks the steps of %s forward, and stays on the last', (mode, steps) => {
      let state = at(mode, { photos: photos(1), destination: { kind: 'new' as const, targetKind: 'exam' as const } });
      const seen: WizardStep[] = [state.step];
      for (let i = 0; i < steps.length + 2; i++) {
        state = wizardReducer(state, { type: 'next' });
        seen.push(state.step);
      }
      expect(seen).toEqual([...steps, ...Array(3).fill(steps[steps.length - 1])]);
    });

    it.each(modes)('walks the steps of %s back, and stays on the first', (mode, steps) => {
      let state = at(mode, { photos: photos(1), destination: { kind: 'new' as const, targetKind: 'exam' as const }, step: steps[steps.length - 1] });
      const seen: WizardStep[] = [state.step];
      for (let i = 0; i < steps.length + 2; i++) {
        state = wizardReducer(state, { type: 'back' });
        seen.push(state.step);
      }
      expect(seen).toEqual([...[...steps].reverse(), ...Array(3).fill(steps[0])]);
    });

    it('goes on to the review when there are photos to review', () => {
      const state = at('photo', { step: 'photos', photos: photos(1) });
      expect(wizardReducer(state, { type: 'next' }).step).toBe('review');
    });

    it('goes past the review when there are no photos', () => {
      expect(wizardReducer(at('photo', { step: 'photos' }), { type: 'next' }).step).toBe('choose');
    });

    it('goes back past the review when there are no photos, so it is never landed on empty', () => {
      expect(wizardReducer(at('photo', { step: 'choose' }), { type: 'back' }).step).toBe('photos');
      expect(wizardReducer(at('photo', { step: 'choose', photos: photos(1) }), { type: 'back' }).step).toBe('review');
    });

    // Phase 64 (spec D8). My words and a prep already open end on the choice; a new prep
    // goes on to more words and its date, and back from there returns to the choice.
    it('ends on the choice for My words or a prep already open', () => {
      for (const destination of [{ kind: 'my-words' as const }, { kind: 'target' as const, targetId: 't1' }]) {
        const state = at('photo', { step: 'choose', photos: photos(1), destination });
        expect(wizardReducer(state, { type: 'next' }).step).toBe('choose');
        expect(isLastStep(state)).toBe(true);
      }
    });

    it('goes on from the choice to more words and the date for a new prep, and back to the choice', () => {
      const state = at('photo', { step: 'choose', photos: photos(1), destination: { kind: 'new' as const, targetKind: 'exam' as const } });
      expect(isLastStep(state)).toBe(false);
      const words = wizardReducer(state, { type: 'next' });
      expect(words.step).toBe('words');
      expect(wizardReducer(words, { type: 'next' }).step).toBe('date');
      expect(wizardReducer(words, { type: 'back' }).step).toBe('choose');
    });

    it('keeps what was chosen as it moves between steps', () => {
      const state = at('photo', {
        step: 'date',
        destination: { kind: 'new' as const, targetKind: 'exam' as const },
        photos: photos(2),
        importIds: ['i0', 'i1'],
        entries: [entry(1)],
        dueOn: '2026-10-20',
      });
      expect(play(state, { type: 'back' }, { type: 'next' })).toEqual(state);
    });
  });

  it('never changes the state it is given', () => {
    const before = at('photo', {
      step: 'photos',
      destination: { kind: 'new' as const, targetKind: 'exam' as const },
      photos: photos(2),
      importIds: ['i0'],
      entries: [entry(1)],
      dueOn: '2026-10-20',
    });
    const copy = JSON.parse(JSON.stringify(before)) as WizardState;
    const actions: WizardAction[] = [
      { type: 'destination', destination: { kind: 'my-words' } },
      { type: 'photos', photos: [photo(5)] },
      { type: 'remove-photo', index: 0 },
      { type: 'uploaded', importIds: ['i0', 'i1'] },
      { type: 'toggle-entry', entry: entry(1) },
      { type: 'toggle-entry', entry: entry(2) },
      { type: 'date', dueOn: '2026-10-25' },
      { type: 'next' },
      { type: 'back' },
    ];
    for (const action of actions) wizardReducer(before, action);
    expect(before).toEqual(copy);
  });
});

describe('photosToUpload', () => {
  it('names the photos past the uploaded ones', () => {
    expect(photosToUpload(at('photo', { photos: photos(3), importIds: ['i0'] }))).toEqual([photo(1), photo(2)]);
    expect(photosToUpload(at('photo', { photos: photos(2) }))).toEqual(photos(2));
  });

  it('names none once every photo is uploaded, so going back and on uploads nothing twice', () => {
    expect(photosToUpload(at('photo', { photos: photos(2), importIds: ['i0', 'i1'] }))).toEqual([]);
    expect(photosToUpload(at('photo'))).toEqual([]);
  });
});

describe('canAdvance', () => {
  it('needs a destination chosen on the choice', () => {
    expect(canAdvance(at('photo', { step: 'choose' }), false)).toBe(false);
    expect(canAdvance(at('photo', { step: 'choose', destination: { kind: 'my-words' } }), false)).toBe(true);
  });

  it('needs a photo on the photos step: the flow starts from one (R2)', () => {
    expect(canAdvance(at('photo'), false)).toBe(false);
    expect(canAdvance(at('photo', { photos: photos(1) }), false)).toBe(true);
  });

  it('waits for every import under review to settle', () => {
    const reviewing = at('photo', { step: 'review', photos: photos(1), importIds: ['i0'] });
    expect(canAdvance(reviewing, false)).toBe(false);
    expect(canAdvance(reviewing, true)).toBe(true);
    expect(canAdvance(at('photo', { step: 'review', photos: photos(1), importIds: ['i0'] }), false)).toBe(false);
  });

  it('asks for a word by the end of the words step: a typed one, or a photo read', () => {
    expect(canAdvance(at('photo', { step: 'words' }), false)).toBe(false);
    expect(canAdvance(at('photo', { step: 'words', entries: [entry(1)] }), false)).toBe(true);
    expect(canAdvance(at('photo', { step: 'words', importIds: ['i0'] }), false)).toBe(true);
    expect(canAdvance(at('add-words'), false)).toBe(false);
    expect(canAdvance(at('add-words', { entries: [entry(1)] }), false)).toBe(true);
  });

  it('needs a date chosen on the date step', () => {
    expect(canAdvance(at('photo', { step: 'date' }), false)).toBe(false);
    expect(canAdvance(at('photo', { step: 'date', dueOn: '2026-10-20' }), false)).toBe(true);
    expect(canAdvance(at('change-date'), false)).toBe(false);
    expect(canAdvance(at('change-date', { dueOn: '2026-10-20' }), false)).toBe(true);
  });

  it('looks at the review only on the review step', () => {
    expect(canAdvance(at('photo', { photos: photos(1) }), true)).toBe(true);
    expect(canAdvance(at('photo'), true)).toBe(false);
    expect(canAdvance(at('photo', { step: 'date', dueOn: '2026-10-20' }), false)).toBe(true);
  });
});

describe('createRequest', () => {
  const ready = at('photo', {
    step: 'date',
    destination: { kind: 'new' as const, targetKind: 'exam' as const },
    dueOn: '2026-10-20',
    importIds: ['i0', 'i1'],
    entries: [entry(1), entry(2)],
  });

  it('is the whole body of a new target, with each word as the server takes it', () => {
    expect(createRequest(ready)).toEqual({
      kind: 'exam',
      due_on: '2026-10-20',
      photo_import_ids: ['i0', 'i1'],
      entries: [
        { gloss_id: 'g1', variant_id: 'v1' },
        { gloss_id: 'g2', variant_id: 'v2' },
      ],
    });
  });

  it('sends nothing of the form and meaning, which only the screen shows', () => {
    expect(Object.keys(createRequest(ready).entries[0]).sort()).toEqual(['gloss_id', 'variant_id']);
  });

  it('sends no photos or no words as an empty list', () => {
    expect(createRequest({ ...ready, importIds: [] }).photo_import_ids).toEqual([]);
    expect(createRequest({ ...ready, entries: [] }).entries).toEqual([]);
  });

  it('takes the kind from a new prep, and throws without one or without a due date', () => {
    expect(createRequest({ ...ready, destination: { kind: 'new', targetKind: 'homework' } }).kind).toBe('homework');
    expect(() => createRequest({ ...ready, destination: null })).toThrow('kind');
    expect(() => createRequest({ ...ready, destination: { kind: 'my-words' } })).toThrow('kind');
    expect(() => createRequest({ ...ready, dueOn: null })).toThrow('due date');
  });
});

describe('addRequest', () => {
  it('is the imports and the words alone, with no kind or date', () => {
    const state = at('photo', {
      step: 'choose',
      destination: { kind: 'target', targetId: 't1' },
      dueOn: '2026-10-20',
      importIds: ['i0'],
      entries: [entry(3)],
    });
    expect(addRequest(state)).toEqual({ photo_import_ids: ['i0'], entries: [{ gloss_id: 'g3', variant_id: 'v3' }] });
  });

  it('carries imports alone, or words alone', () => {
    expect(addRequest(at('photo', { importIds: ['i0', 'i1'] }))).toEqual({
      photo_import_ids: ['i0', 'i1'],
      entries: [],
    });
    expect(addRequest(at('add-words', { entries: [entry(1), entry(2)] }))).toEqual({
      photo_import_ids: [],
      entries: [
        { gloss_id: 'g1', variant_id: 'v1' },
        { gloss_id: 'g2', variant_id: 'v2' },
      ],
    });
  });
});

describe('what a lookup card adds', () => {
  const sense = (over: Partial<TranslationSense> = {}): TranslationSense => ({
    translation: 'אצבעות',
    gloss_id: 'g1',
    variant_id: 'v1',
    saved: false,
    ...over,
  });

  describe('pickedEntryOf', () => {
    it("is the card's gloss and variant, with the word looked up and the gloss's key", () => {
      expect(pickedEntryOf({ text: 'dita' }, sense({ key: 'אצבע' }))).toEqual({
        gloss_id: 'g1',
        variant_id: 'v1',
        form: 'dita',
        meaning: 'אצבע',
      });
    });

    it('names the form the lookup was corrected to, not the typo', () => {
      const result = { text: 'dtia', correction: { corrected_form: 'dita', alternatives: [] } };
      expect(pickedEntryOf(result, sense({ key: 'אצבע' }))?.form).toBe('dita');
    });

    it('has the rendering as the meaning when the card shows no key, which is then the key', () => {
      expect(pickedEntryOf({ text: 'gatto' }, sense({ translation: 'חתול' }))?.meaning).toBe('חתול');
    });

    it('is null for a card that cannot be added: no gloss, or no variant', () => {
      expect(pickedEntryOf({ text: 'dita' }, sense({ gloss_id: undefined }))).toBeNull();
      expect(pickedEntryOf({ text: 'dita' }, sense({ variant_id: undefined }))).toBeNull();
    });
  });

  describe('pickedStateOf', () => {
    it('answers for each card that can be added whether it is picked', () => {
      expect(pickedStateOf({ g1: false, g2: true }, (glossId) => glossId === 'g1')).toEqual({ g1: true, g2: false });
    });

    it('has nothing for a lookup with no card that can be added', () => {
      expect(pickedStateOf({}, () => true)).toEqual({});
    });
  });

  describe('unpickedEntries', () => {
    const result = {
      text: 'dita',
      senses: [
        sense({ gloss_id: 'g1', variant_id: 'v1', key: 'אצבע' }),
        sense({ gloss_id: 'g2', variant_id: 'v2', translation: 'ציפורן' }),
        sense({ gloss_id: 'g3', variant_id: 'v3', translation: 'כף' }),
        sense({ gloss_id: undefined, variant_id: undefined, translation: 'משפט' }),
      ],
    };

    it('lists the cards that can be added and are not picked, in card order', () => {
      expect(unpickedEntries(result, { g1: false, g2: true, g3: false })).toEqual([
        { gloss_id: 'g1', variant_id: 'v1', form: 'dita', meaning: 'אצבע' },
        { gloss_id: 'g3', variant_id: 'v3', form: 'dita', meaning: 'כף' },
      ]);
    });

    it('leaves out a card the lookup gave no state for, and lists a gloss once', () => {
      const twice = { ...result, senses: [...result.senses, sense({ gloss_id: 'g1', variant_id: 'v1' })] };
      expect(unpickedEntries(twice, { g1: false }).map((picked) => picked.gloss_id)).toEqual(['g1']);
      expect(unpickedEntries(result, {})).toEqual([]);
    });

    it('lists nothing when every card is picked', () => {
      expect(unpickedEntries(result, { g1: true, g2: true, g3: true })).toEqual([]);
    });
  });
});

describe('wizardRouteOf', () => {
  it('is a new target with no mode, and for an unknown one', () => {
    expect(wizardRouteOf({})).toEqual({ mode: 'photo', targetId: null });
    expect(wizardRouteOf({ mode: 'photo' })).toEqual({ mode: 'photo', targetId: null });
    expect(wizardRouteOf({ mode: 'rename', targetId: 't1' })).toEqual({ mode: 'photo', targetId: null });
    // Phase 64 (spec D8): the photo flow replaced both of these.
    expect(wizardRouteOf({ mode: 'create' })).toEqual({ mode: 'photo', targetId: null });
    expect(wizardRouteOf({ mode: 'add-photos', targetId: 't1' })).toEqual({ mode: 'photo', targetId: null });
    expect(wizardRouteOf({ mode: ['add-words', 'change-date'], targetId: 't1' })).toEqual({ mode: 'photo', targetId: null });
  });

  it("is a target's action with the target it acts on", () => {
    expect(wizardRouteOf({ mode: 'add-words', targetId: 't1' })).toEqual({ mode: 'add-words', targetId: 't1' });
    expect(wizardRouteOf({ mode: 'change-date', targetId: 't1' })).toEqual({ mode: 'change-date', targetId: 't1' });
  });

  it('is nothing for an action with no target to act on', () => {
    expect(wizardRouteOf({ mode: 'add-words' })).toBeNull();
    expect(wizardRouteOf({ mode: 'add-words', targetId: '' })).toBeNull();
    expect(wizardRouteOf({ mode: 'change-date', targetId: ['t1', 't2'] })).toBeNull();
  });
});

describe('isFirstStep and isLastStep', () => {
  it('knows where each mode starts and where Done is', () => {
    expect(isFirstStep(at('photo'))).toBe(true);
    expect(isLastStep(at('photo'))).toBe(false);
    expect(isFirstStep(at('photo', { step: 'review' }))).toBe(false);
    expect(isLastStep(at('photo', { step: 'date', destination: { kind: 'new', targetKind: 'homework' } }))).toBe(true);
    // Before a destination is chosen, the choice is as far as the flow goes.
    expect(isLastStep(at('photo', { step: 'choose' }))).toBe(true);
  });

  it('is both on the one step of an addition of words or a change of date', () => {
    for (const mode of ['add-words', 'change-date'] as const) {
      expect(isFirstStep(at(mode))).toBe(true);
      expect(isLastStep(at(mode))).toBe(true);
    }
  });
});

describe('holdsPicks', () => {
  it('is true once a photo or a word is held, which leaving would lose', () => {
    expect(holdsPicks(at('photo'))).toBe(false);
    expect(holdsPicks(at('photo', { destination: { kind: 'my-words' }, dueOn: '2026-10-20' }))).toBe(false);
    expect(holdsPicks(at('photo', { photos: photos(1) }))).toBe(true);
    expect(holdsPicks(at('add-words', { entries: [entry(1)] }))).toBe(true);
  });
});

describe('dateRequest', () => {
  it('is the date chosen, and throws without one', () => {
    expect(dateRequest(at('change-date', { dueOn: '2026-10-22' }))).toEqual({ due_on: '2026-10-22' });
    expect(() => dateRequest(at('change-date'))).toThrow();
  });
});

describe('discardLeftNothing', () => {
  // A removed photo's import is discarded before the photo goes, so none is left behind.
  it('lets the photo go when the server says its import is gone or saved', () => {
    expect(discardLeftNothing(new ApiError(404, 'photo import not found'))).toBe(true);
    expect(discardLeftNothing(new ApiError(409, 'photo import not ready'))).toBe(true);
  });

  it('keeps the photo when the import may still be there', () => {
    expect(discardLeftNothing(new ApiError(500))).toBe(false);
    expect(discardLeftNothing(new ApiError(401, 'not signed in'))).toBe(false);
    expect(discardLeftNothing(new TypeError('Network request failed'))).toBe(false);
  });
});

// Final review I2. The imports the wizard made, which every way out of it discards: Cancel and
// Back waiting for it, an unmount (a reminder's tap, the browser's back, a swipe) not.
describe('discardImports', () => {
  it('discards every import the wizard made, and empties its list: a second call discards none', async () => {
    const made = { current: ['i_a', 'i_b'] };
    const asked: string[] = [];
    const discard = async (importId: string) => {
      asked.push(importId);
    };
    await discardImports(made, discard);
    expect(asked).toEqual(['i_a', 'i_b']);
    expect(made.current).toEqual([]);
    await discardImports(made, discard);
    expect(asked).toEqual(['i_a', 'i_b']);
  });

  it('empties the list before any discard answers, so none is sent twice', () => {
    const made = { current: ['i_a'] };
    void discardImports(made, () => new Promise(() => undefined));
    expect(made.current).toEqual([]);
  });

  it('never rejects: a discard that fails or throws leaves its import in the photo-import list, and the rest still go', async () => {
    const asked: string[] = [];
    const discard = (importId: string): Promise<void> => {
      asked.push(importId);
      if (importId === 'i_a') return Promise.reject(new ApiError(500));
      if (importId === 'i_b') throw new TypeError('Network request failed');
      return Promise.resolve();
    };
    await expect(discardImports({ current: ['i_a', 'i_b', 'i_c'] }, discard)).resolves.toBeUndefined();
    expect(asked).toEqual(['i_a', 'i_b', 'i_c']);
  });
});

describe('saveHolding', () => {
  it("holds the imports out of the wizard's list while Done is on its way, so leaving meanwhile discards none of them", async () => {
    const made = { current: ['i_a', 'i_b'] };
    let during: string[] | null = null;
    const answer = await saveHolding(made, async () => {
      during = [...made.current];
      return 'saved';
    });
    expect(answer).toBe('saved');
    expect(during).toEqual([]);
    // Saved with the target: none is the wizard's to discard any more.
    expect(made.current).toEqual([]);
  });

  it('gives them back when Done fails, so Cancel still discards them', async () => {
    const made = { current: ['i_a', 'i_b'] };
    const failure = new ApiError(409, 'photo import conflict');
    await expect(
      saveHolding(made, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(made.current).toEqual(['i_a', 'i_b']);
  });
});

describe('photosFull and entriesFull', () => {
  it('says when the wizard holds as many photos or words as a request carries', () => {
    expect(photosFull(at('photo', { photos: photos(MAX_PHOTOS - 1) }))).toBe(false);
    expect(photosFull(at('photo', { photos: photos(MAX_PHOTOS) }))).toBe(true);
    const words = (count: number) => Array.from({ length: count }, (_, n) => entry(n));
    expect(entriesFull(at('add-words', { entries: words(MAX_ENTRIES - 1) }))).toBe(false);
    expect(entriesFull(at('add-words', { entries: words(MAX_ENTRIES) }))).toBe(true);
  });
});

describe('holdsEntry', () => {
  // The lookup's collect mode reads a card's state from it.
  it('knows a picked word by its gloss', () => {
    const state = at('add-words', { entries: [entry(1), entry(2)] });
    expect(holdsEntry(state, 'g2')).toBe(true);
    expect(holdsEntry(state, 'g3')).toBe(false);
    expect(holdsEntry(at('add-words'), 'g1')).toBe(false);
  });
});
