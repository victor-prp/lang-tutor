import { describe, expect, it } from '@jest/globals';
import type { TranslationSense } from '@lang-tutor/core/api';

import type { Photo } from './photos';
import {
  MAX_ENTRIES,
  MAX_PHOTOS,
  addRequest,
  canAdvance,
  createRequest,
  initialWizard,
  photosToUpload,
  pickedEntryOf,
  pickedStateOf,
  stepsFor,
  unpickedEntries,
  wizardReducer,
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
    expect(stepsFor('create')).toEqual(['kind', 'photos', 'review', 'words', 'date']);
    expect(stepsFor('add-photos')).toEqual(['photos', 'review']);
    expect(stepsFor('add-words')).toEqual(['words']);
    expect(stepsFor('change-date')).toEqual(['date']);
  });

  it('hands out a copy, so a caller cannot change the steps of a mode', () => {
    stepsFor('create').pop();
    expect(stepsFor('create')).toHaveLength(5);
  });
});

describe('initialWizard', () => {
  it('starts every mode on its first step, with nothing chosen', () => {
    expect(initialWizard('create')).toEqual({
      mode: 'create',
      step: 'kind',
      kind: null,
      photos: [],
      importIds: [],
      entries: [],
      dueOn: null,
    });
    expect(initialWizard('add-photos').step).toBe('photos');
    expect(initialWizard('add-words').step).toBe('words');
    expect(initialWizard('change-date').step).toBe('date');
  });

  it('shares no list between two wizards', () => {
    const [one, two] = [initialWizard('create'), initialWizard('create')];
    expect(one.photos).not.toBe(two.photos);
    expect(one.entries).not.toBe(two.entries);
    expect(one.importIds).not.toBe(two.importIds);
  });
});

describe('wizardReducer', () => {
  describe('kind', () => {
    it('sets the kind, and a later choice replaces it', () => {
      const state = play(initialWizard('create'), { type: 'kind', kind: 'exam' });
      expect(state.kind).toBe('exam');
      expect(play(state, { type: 'kind', kind: 'homework' }).kind).toBe('homework');
    });
  });

  describe('photos', () => {
    it('adds photos after the ones held, in order', () => {
      const state = play(
        initialWizard('create'),
        { type: 'photos', photos: [photo(1)] },
        { type: 'photos', photos: [photo(2), photo(3)] },
      );
      expect(state.photos).toEqual([photo(1), photo(2), photo(3)]);
    });

    it('holds no more photos than a request carries', () => {
      expect(MAX_PHOTOS).toBe(10);
      const state = play(
        initialWizard('create'),
        { type: 'photos', photos: photos(8) },
        { type: 'photos', photos: [photo(8), photo(9), photo(10), photo(11), photo(12)] },
      );
      expect(state.photos).toEqual(photos(10));
      expect(play(state, { type: 'photos', photos: [photo(13)] }).photos).toEqual(photos(10));
    });
  });

  describe('remove-photo', () => {
    it('removes the photo at an index and leaves the others in order', () => {
      const state = play(at('create', { photos: photos(3) }), { type: 'remove-photo', index: 1 });
      expect(state.photos).toEqual([photo(0), photo(2)]);
    });

    it('ignores an index with no photo', () => {
      const before = at('create', { photos: photos(2) });
      expect(wizardReducer(before, { type: 'remove-photo', index: 2 })).toBe(before);
      expect(wizardReducer(before, { type: 'remove-photo', index: -1 })).toBe(before);
    });

    // importIds[i] is the import of photos[i]; a removed photo's import goes from
    // the list with it, or the next removal would drop the wrong photo's import.
    it("takes a removed photo's import with it, when it was uploaded", () => {
      const before = at('create', { photos: photos(3), importIds: ['i0', 'i1'] });
      const first = wizardReducer(before, { type: 'remove-photo', index: 0 });
      expect(first.photos).toEqual([photo(1), photo(2)]);
      expect(first.importIds).toEqual(['i1']);
      // A photo not uploaded yet has no import to take.
      expect(wizardReducer(before, { type: 'remove-photo', index: 2 }).importIds).toEqual(['i0', 'i1']);
    });
  });

  describe('uploaded', () => {
    it('records the imports of the photos uploaded, in photo order', () => {
      const state = play(at('create', { photos: photos(2) }), { type: 'uploaded', importIds: ['i0', 'i1'] });
      expect(state.importIds).toEqual(['i0', 'i1']);
    });

    it('replaces the imports it held, so the screen passes every one uploaded so far', () => {
      const state = play(
        at('create', { photos: photos(3), importIds: ['i0'] }),
        { type: 'uploaded', importIds: ['i0', 'i1', 'i2'] },
      );
      expect(state.importIds).toEqual(['i0', 'i1', 'i2']);
    });
  });

  describe('toggle-entry', () => {
    it('picks a word, and picks it out again on a second toggle', () => {
      const picked = play(initialWizard('create'), { type: 'toggle-entry', entry: entry(1) });
      expect(picked.entries).toEqual([entry(1)]);
      expect(play(picked, { type: 'toggle-entry', entry: entry(1) }).entries).toEqual([]);
    });

    it('knows a word by its gloss, whatever form it comes with', () => {
      const picked = play(initialWizard('create'), { type: 'toggle-entry', entry: entry(1) });
      const again = { ...entry(1), form: 'another form', meaning: 'another meaning' };
      expect(play(picked, { type: 'toggle-entry', entry: again }).entries).toEqual([]);
    });

    it('keeps the words in the order they were picked', () => {
      const state = play(
        initialWizard('create'),
        { type: 'toggle-entry', entry: entry(1) },
        { type: 'toggle-entry', entry: entry(2) },
        { type: 'toggle-entry', entry: entry(3) },
        { type: 'toggle-entry', entry: entry(2) },
      );
      expect(state.entries).toEqual([entry(1), entry(3)]);
    });

    it('holds no more words than a request carries, and still lets one go', () => {
      expect(MAX_ENTRIES).toBe(50);
      const full = at('create', { entries: Array.from({ length: 50 }, (_, n) => entry(n)) });
      expect(play(full, { type: 'toggle-entry', entry: entry(50) }).entries).toHaveLength(50);
      expect(play(full, { type: 'toggle-entry', entry: entry(7) }).entries).toHaveLength(49);
    });
  });

  describe('date', () => {
    it('sets the due date, and a later choice replaces it', () => {
      const state = play(initialWizard('create'), { type: 'date', dueOn: '2026-10-20' });
      expect(state.dueOn).toBe('2026-10-20');
      expect(play(state, { type: 'date', dueOn: '2026-10-22' }).dueOn).toBe('2026-10-22');
    });
  });

  describe('next and back', () => {
    // Photos held, so the review is not skipped.
    const modes: [WizardMode, WizardStep[]][] = [
      ['create', ['kind', 'photos', 'review', 'words', 'date']],
      ['add-photos', ['photos', 'review']],
      ['add-words', ['words']],
      ['change-date', ['date']],
    ];

    it.each(modes)('walks the steps of %s forward, and stays on the last', (mode, steps) => {
      let state = at(mode, { photos: photos(1) });
      const seen: WizardStep[] = [state.step];
      for (let i = 0; i < steps.length + 2; i++) {
        state = wizardReducer(state, { type: 'next' });
        seen.push(state.step);
      }
      expect(seen).toEqual([...steps, ...Array(3).fill(steps[steps.length - 1])]);
    });

    it.each(modes)('walks the steps of %s back, and stays on the first', (mode, steps) => {
      let state = at(mode, { photos: photos(1), step: steps[steps.length - 1] });
      const seen: WizardStep[] = [state.step];
      for (let i = 0; i < steps.length + 2; i++) {
        state = wizardReducer(state, { type: 'back' });
        seen.push(state.step);
      }
      expect(seen).toEqual([...[...steps].reverse(), ...Array(3).fill(steps[0])]);
    });

    it('goes on to the review when there are photos to review', () => {
      const state = at('create', { step: 'photos', photos: photos(1) });
      expect(wizardReducer(state, { type: 'next' }).step).toBe('review');
    });

    it('goes past the review when there are no photos', () => {
      expect(wizardReducer(at('create', { step: 'photos' }), { type: 'next' }).step).toBe('words');
    });

    it('goes back past the review when there are no photos, so it is never landed on empty', () => {
      expect(wizardReducer(at('create', { step: 'words' }), { type: 'back' }).step).toBe('photos');
      expect(wizardReducer(at('create', { step: 'words', photos: photos(1) }), { type: 'back' }).step).toBe('review');
    });

    it('has nowhere to go from the photos of an addition that has none', () => {
      expect(wizardReducer(at('add-photos'), { type: 'next' }).step).toBe('photos');
    });

    it('keeps what was chosen as it moves between steps', () => {
      const state = at('create', {
        step: 'date',
        kind: 'exam',
        photos: photos(2),
        importIds: ['i0', 'i1'],
        entries: [entry(1)],
        dueOn: '2026-10-20',
      });
      expect(play(state, { type: 'back' }, { type: 'next' })).toEqual(state);
    });
  });

  it('never changes the state it is given', () => {
    const before = at('create', {
      step: 'photos',
      kind: 'exam',
      photos: photos(2),
      importIds: ['i0'],
      entries: [entry(1)],
      dueOn: '2026-10-20',
    });
    const copy = JSON.parse(JSON.stringify(before)) as WizardState;
    const actions: WizardAction[] = [
      { type: 'kind', kind: 'homework' },
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
    expect(photosToUpload(at('create', { photos: photos(3), importIds: ['i0'] }))).toEqual([photo(1), photo(2)]);
    expect(photosToUpload(at('create', { photos: photos(2) }))).toEqual(photos(2));
  });

  it('names none once every photo is uploaded, so going back and on uploads nothing twice', () => {
    expect(photosToUpload(at('create', { photos: photos(2), importIds: ['i0', 'i1'] }))).toEqual([]);
    expect(photosToUpload(at('create'))).toEqual([]);
  });
});

describe('canAdvance', () => {
  it('needs a kind chosen on the kind step', () => {
    expect(canAdvance(at('create'), false)).toBe(false);
    expect(canAdvance(at('create', { kind: 'homework' }), false)).toBe(true);
  });

  it('lets a new target go on without photos, but an addition of photos needs one', () => {
    expect(canAdvance(at('create', { step: 'photos' }), false)).toBe(true);
    expect(canAdvance(at('add-photos'), false)).toBe(false);
    expect(canAdvance(at('add-photos', { photos: photos(1) }), false)).toBe(true);
  });

  it('waits for every import under review to settle', () => {
    const reviewing = at('create', { step: 'review', photos: photos(1), importIds: ['i0'] });
    expect(canAdvance(reviewing, false)).toBe(false);
    expect(canAdvance(reviewing, true)).toBe(true);
    expect(canAdvance(at('add-photos', { step: 'review', photos: photos(1), importIds: ['i0'] }), false)).toBe(false);
  });

  it('asks for a word by the end of the words step: a typed one, or a photo read', () => {
    expect(canAdvance(at('create', { step: 'words' }), false)).toBe(false);
    expect(canAdvance(at('create', { step: 'words', entries: [entry(1)] }), false)).toBe(true);
    expect(canAdvance(at('create', { step: 'words', importIds: ['i0'] }), false)).toBe(true);
    expect(canAdvance(at('add-words'), false)).toBe(false);
    expect(canAdvance(at('add-words', { entries: [entry(1)] }), false)).toBe(true);
  });

  it('needs a date chosen on the date step', () => {
    expect(canAdvance(at('create', { step: 'date' }), false)).toBe(false);
    expect(canAdvance(at('create', { step: 'date', dueOn: '2026-10-20' }), false)).toBe(true);
    expect(canAdvance(at('change-date'), false)).toBe(false);
    expect(canAdvance(at('change-date', { dueOn: '2026-10-20' }), false)).toBe(true);
  });

  it('looks at the review only on the review step', () => {
    expect(canAdvance(at('create', { kind: 'exam' }), true)).toBe(true);
    expect(canAdvance(at('create'), true)).toBe(false);
    expect(canAdvance(at('create', { step: 'date', dueOn: '2026-10-20' }), false)).toBe(true);
  });
});

describe('createRequest', () => {
  const ready = at('create', {
    step: 'date',
    kind: 'exam',
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

  it('throws without a kind or without a due date', () => {
    expect(() => createRequest({ ...ready, kind: null })).toThrow('kind');
    expect(() => createRequest({ ...ready, dueOn: null })).toThrow('due date');
  });
});

describe('addRequest', () => {
  it('is the imports and the words alone, with no kind or date', () => {
    const state = at('add-photos', {
      step: 'review',
      kind: 'exam',
      dueOn: '2026-10-20',
      importIds: ['i0'],
      entries: [entry(3)],
    });
    expect(addRequest(state)).toEqual({ photo_import_ids: ['i0'], entries: [{ gloss_id: 'g3', variant_id: 'v3' }] });
  });

  it('carries imports alone, or words alone', () => {
    expect(addRequest(at('add-photos', { importIds: ['i0', 'i1'] }))).toEqual({
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
