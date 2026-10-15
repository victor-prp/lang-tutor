import { describe, expect, it } from '@jest/globals';
import type { CreateTargetRequest, Enrollment, VocabularyEntryInput } from '@lang-tutor/core/api';
import { FSRS6_DEFAULT, type Dimension, type MemoryState } from '@lang-tutor/core/domain';

import {
  createFakeClock,
  createFakeGlossRepo,
  createFakeJobRepo,
  createFakeLogger,
  createFakeTargetRepo,
  createFakeTransaction,
  stub,
} from '../../tests/support/fakes';
import { STOCK_SESSION } from '../domain/jobs';
import type { MemoryRow } from '../domain/memoryUpdate';
import { IMPORT_TTL_MS } from '../domain/photoImports';
import type { Devices, SavedGloss, SessionSummary } from '../domain/session';
import {
  AccessDenied,
  EnrollmentNotFound,
  InvalidTarget,
  PhotoImportConflict,
  PhotoImportNotFound,
  TargetClosed,
  TargetNotFound,
} from '../errors';
import type { DictRepo } from '../repo/dictionary';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { GrantRepo } from '../repo/grants';
import type { MemoryRepo } from '../repo/memory';
import type { PhotoImportItemRow, PhotoImportRepo, PhotoImportRow } from '../repo/photoImports';
import type { SessionRepo } from '../repo/sessions';
import type { TargetEventInput, TargetRow } from '../repo/targets';
import type { UserRepo } from '../repo/users';
import type { VocabularyRepo } from '../repo/vocabulary';
import { createTargetService, type TargetService } from './targets';
import type { Repos } from './transaction';
import { createVocabularyService } from './vocabulary';

// Phase 53 (spec D1, D2, D4, D8, D10–D12; rulings R-D9 to R-D12b). A learner's targets:
// made from photos and typed words saved in the same transaction, changed, ended, and read
// with each word's readiness for the date. Every change retires the unstarted list stock and
// asks for a new one. The learner's day is 2026-10-15 (UTC).

const NOW = Date.parse('2026-10-15T09:00:00Z');
const TODAY = '2026-10-15';
const DUE = '2026-10-20';
const OWNER = 'u1';
const STRANGER = 'u2';
const TUTOR = 'u3';
const ENROLLMENT = { id: 'e1', user_id: OWNER, source_language: 'he', target_language: 'it', created_at: '' } as Enrollment;
const OTHER_LIST = { ...ENROLLMENT, id: 'e2', target_language: 'es' } as Enrollment;

/** Every gloss a test can save: the variant it is saved by, and what the list reads back. */
const WORDS: Record<string, { variantId: string; lexemeId: string; lemma: string; form: string; key: string }> = {
  g_casa: { variantId: 'v_casa', lexemeId: 'l_casa', lemma: 'casa', form: 'casa', key: 'בית' },
  g_gatto: { variantId: 'v_gatto', lexemeId: 'l_gatto', lemma: 'gatto', form: 'gatto', key: 'חתול' },
  g_cane: { variantId: 'v_cane', lexemeId: 'l_cane', lemma: 'cane', form: 'cane', key: 'כלב' },
  g_sole: { variantId: 'v_sole', lexemeId: 'l_sole', lemma: 'sole', form: 'sole', key: 'שמש' },
  // Five words, past MAX_SPOKEN_WORDS: never asked aloud (ruling R-D4).
  g_lupo: { variantId: 'v_lupo', lexemeId: 'l_lupo', lemma: 'in bocca al lupo', form: 'in bocca al lupo sempre', key: 'בהצלחה' },
};
const entry = (glossId: string): VocabularyEntryInput => ({ gloss_id: glossId, variant_id: WORDS[glossId].variantId });
const savedGloss = (glossId: string): SavedGloss => ({
  glossId,
  key: WORDS[glossId].key,
  variantId: WORDS[glossId].variantId,
  savedAt: '2026-10-01T09:00:00.000000Z',
  lexemeId: WORDS[glossId].lexemeId,
  lemma: WORDS[glossId].lemma,
  form: WORDS[glossId].form,
  order: [0, 0],
  knownAt: null,
});

const importRow = (id: string, over: Partial<PhotoImportRow> = {}): PhotoImportRow => ({
  id,
  enrollmentId: 'e1',
  status: 'read',
  createdAt: new Date(NOW - 60_000),
  ...over,
});
/** A looked-up row on `glossId`, ticked, as the reading and the lookup leave one. */
const itemRow = (importId: string, position: number, glossId: string, over: Partial<PhotoImportItemRow> = {}): PhotoImportItemRow => ({
  importId,
  position,
  text: WORDS[glossId].form,
  hebrew: null,
  status: 'ready',
  correctedForm: null,
  options: [{ gloss_id: glossId, variant_id: WORDS[glossId].variantId, translation: WORDS[glossId].key }],
  suggestedGlossId: glossId,
  chosenGlossId: glossId,
  ticked: true,
  hebrewMismatch: false,
  reason: null,
  ...over,
});
type SeededImport = { row: PhotoImportRow; items: PhotoImportItemRow[] };
const photo = (id: string, glossIds: string[], over: Partial<PhotoImportRow> = {}): SeededImport => ({
  row: importRow(id, over),
  items: glossIds.map((glossId, position) => itemRow(id, position, glossId)),
});

type StoredTarget = TargetRow & { words: string[] };
const target = (over: Partial<StoredTarget> = {}): StoredTarget => ({
  id: 't1',
  enrollmentId: 'e1',
  kind: 'exam',
  dueOn: DUE,
  createdAt: new Date(NOW - 86_400_000),
  endedAt: null,
  words: ['g_casa'],
  ...over,
});

const ALL_SKILLS: Dimension[] = ['written_receptive', 'written_productive', 'spoken_receptive', 'spelling', 'spoken_productive'];
const memory = (glossId: string, dimensions: readonly Dimension[], state: MemoryState): MemoryRow[] =>
  dimensions.map((dimension) => ({ glossId, dimension, state, reachedOn: null }));
/** Remembered all but surely on DUE. */
const solid: MemoryState = { stability: 1000, difficulty: 5, lastDay: TODAY, reps: 6, lapses: 0, params: FSRS6_DEFAULT.id };
/** Recalled 0.846 on DUE (stability 10, last asked 20 days before): homework-ready, an exam's "almost". */
const fading: MemoryState = { stability: 10, difficulty: 5, lastDay: '2026-09-30', reps: 3, lapses: 0, params: FSRS6_DEFAULT.id };

const listStock = (id = 's_stock'): SessionSummary => ({ id, status: 'ready', source: 'list', answered: 0, total: 10 });
const TARGET_STOCK = { name: STOCK_SESSION, data: { enrollment_id: 'e1', reason: 'target' }, options: { singletonKey: 'e1' } };

type DayContext = NonNullable<Awaited<ReturnType<UserRepo['findDayContext']>>>;

/**
 * One learner's world, held in memory: their list, their photo imports, their targets and
 * their sessions, behind the repositories the services read and write. `calls` names the
 * reads and writes whose order a test checks.
 */
function world(
  setup: {
    day?: DayContext;
    saved?: string[];
    imports?: SeededImport[];
    targets?: StoredTarget[];
    memory?: MemoryRow[];
    devices?: Devices;
    open?: { started?: SessionSummary; stock?: SessionSummary };
    /** Whether retireStock finds the stock still unstarted; false when a start took it first. */
    retires?: boolean;
    gloss?: Repos['gloss'];
    grant?: Awaited<ReturnType<GrantRepo['findGrantFor']>>;
  } = {},
) {
  const calls: string[] = [];
  const logger = createFakeLogger();
  const jobs = createFakeJobRepo();

  const saved = [...(setup.saved ?? [])];
  const inserted: string[][] = [];
  const vocabulary = stub<VocabularyRepo>({
    findSaveable: async ({ entries }) =>
      entries.flatMap(({ glossId, variantId }) => {
        const word = WORDS[glossId];
        return word && word.variantId === variantId ? [{ glossId, variantId, lexemeId: word.lexemeId, lemma: word.lemma }] : [];
      }),
    insertEntries: async ({ entries }) => {
      calls.push('insertEntries');
      inserted.push(entries.map((saveable) => saveable.glossId));
      for (const { glossId } of entries) if (!saved.includes(glossId)) saved.push(glossId);
    },
    deleteEntry: async ({ glossId }) => {
      calls.push(`deleteEntry ${glossId}`);
      if (saved.includes(glossId)) saved.splice(saved.indexOf(glossId), 1);
    },
    listSavedGlosses: async () => saved.map(savedGloss),
  });

  const imports = new Map((setup.imports ?? []).map(({ row, items }) => [row.id, { row: { ...row }, items }]));
  const transitions: unknown[][] = [];
  const photoImport = stub<PhotoImportRepo>({
    findImportForUpdate: async (id) => {
      calls.push(`findImportForUpdate ${id}`);
      return imports.get(id)?.row ?? null;
    },
    listItems: async (id) => imports.get(id)?.items ?? [],
    transition: async (id, from, to) => {
      transitions.push([id, from, to]);
      const found = imports.get(id);
      if (!found || !from.includes(found.row.status)) return false;
      found.row.status = to;
      return true;
    },
  });

  const stored = new Map((setup.targets ?? []).map((row) => [row.id, { ...row, words: [...row.words] }]));
  const plain = ({ words: _words, ...row }: StoredTarget): TargetRow => row;
  const events: TargetEventInput[] = [];
  const created: unknown[] = [];
  const target = createFakeTargetRepo({
    insertTarget: async (row) => {
      calls.push('insertTarget');
      created.push(row);
      const made: StoredTarget = { id: 't_new', ...row, createdAt: new Date(NOW), endedAt: null, words: [] };
      stored.set(made.id, made);
      return plain(made);
    },
    findTarget: async (id) => {
      calls.push('findTarget');
      const found = stored.get(id);
      return found ? plain(found) : null;
    },
    findTargetForUpdate: async (id) => {
      calls.push('findTargetForUpdate');
      const found = stored.get(id);
      return found ? plain(found) : null;
    },
    listActive: async (enrollmentId, today) =>
      [...stored.values()]
        .filter((row) => row.enrollmentId === enrollmentId && row.dueOn > today && row.endedAt === null)
        .sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.id.localeCompare(b.id))
        .map((row) => ({ ...plain(row), glossIds: [...row.words] })),
    listWordIds: async (id) => [...(stored.get(id)?.words ?? [])],
    addWords: async (id, glossIds) => {
      calls.push('addWords');
      const row = stored.get(id)!;
      const added = [...new Set(glossIds)].filter((glossId) => !row.words.includes(glossId));
      row.words.push(...added);
      return added;
    },
    removeWord: async (id, glossId) => {
      const row = stored.get(id)!;
      if (!row.words.includes(glossId)) return false;
      row.words = row.words.filter((word) => word !== glossId);
      return true;
    },
    removeGlossFromTargets: async (enrollmentId, glossId) => {
      calls.push(`removeGlossFromTargets ${glossId}`);
      const left = [...stored.values()].filter((row) => row.enrollmentId === enrollmentId && row.words.includes(glossId));
      for (const row of left) row.words = row.words.filter((word) => word !== glossId);
      return left.map((row) => row.id).sort();
    },
    setDueOn: async (id, dueOn) => {
      stored.get(id)!.dueOn = dueOn;
    },
    end: async (id, at) => {
      const row = stored.get(id)!;
      if (row.endedAt !== null) return false;
      row.endedAt = at;
      return true;
    },
    insertEvent: async (event) => {
      calls.push(`insertEvent ${event.kind}`);
      events.push(event);
    },
  });

  const retired: string[] = [];
  const session = stub<SessionRepo>({
    lockNextSession: async () => {
      calls.push('lockNextSession');
    },
    findOpen: async () => setup.open ?? {},
    retireStock: async (sessionId) => {
      calls.push('retireStock');
      retired.push(sessionId);
      return setup.retires ?? true;
    },
    findNewestDevices: async () => setup.devices,
  });

  const transaction = createFakeTransaction({
    enrollment: stub<EnrollmentRepo>({ findById: async (id) => [ENROLLMENT, OTHER_LIST].find((enrolled) => enrolled.id === id) }),
    grant: stub<GrantRepo>({ findGrantFor: async () => setup.grant ?? null }),
    user: stub<UserRepo>({ findDayContext: async () => setup.day ?? { kind: 'learner' as const, timeZone: 'UTC' } }),
    vocabulary,
    photoImport,
    target,
    session,
    memory: stub<MemoryRepo>({
      findRows: async ({ glossIds }) => (setup.memory ?? []).filter((row) => glossIds.includes(row.glossId)),
    }),
    gloss: setup.gloss ?? createFakeGlossRepo(),
    dict: stub<DictRepo>({ claimLemmaRenders: async () => [] }),
    jobs,
  });
  const service = createTargetService({ transaction, logger, now: createFakeClock(NOW), stockSaveDelaySeconds: 30 });
  const vocabularyService = createVocabularyService({ transaction, logger, stockSaveDelaySeconds: 30 });
  return { service, vocabularyService, logger, jobs, calls, saved, inserted, transitions, stored, events, created, retired };
}

const createRequest = (over: Partial<CreateTargetRequest> = {}): CreateTargetRequest => ({
  kind: 'exam',
  due_on: DUE,
  photo_import_ids: [],
  entries: [entry('g_casa')],
  ...over,
});
const word = (glossId: string, readiness: string) => ({ gloss_id: glossId, form: WORDS[glossId].form, meaning: WORDS[glossId].key, readiness });
const logged = (logger: { events: Record<string, unknown>[] }, event: string) => logger.events.filter((line) => line.event === event);
/** Final review I3. A photo import saved through a target, logged as its own save logs it (phase
 *  26 D14), with the target named. */
const importSaved = (importId: string, saved: number, unticked = 0, changed = 0, targetId = 't_new') => ({
  event: 'photo_import_saved',
  import_id: importId,
  saved_count: saved,
  unticked_count: unticked,
  changed_gloss_count: changed,
  target_id: targetId,
});

describe('create (spec D10, rulings R-D9, R-D10)', () => {
  it('saves the photos’ rows and the typed words, and makes one target of them: the photos’ first, each word once', async () => {
    const { service, saved, inserted, transitions, created, events, jobs, logger } = world({
      imports: [photo('i_a', ['g_casa', 'g_gatto']), photo('i_b', ['g_gatto', 'g_cane'])],
    });

    const made = await service.create(OWNER, 'e1', createRequest({ photo_import_ids: ['i_a', 'i_b'], entries: [entry('g_cane'), entry('g_sole')] }));

    expect(made).toEqual({
      id: 't_new',
      kind: 'exam',
      due_on: DUE,
      days_left: 5,
      word_count: 4,
      ready_count: 0,
      words: [word('g_casa', 'not_started'), word('g_gatto', 'not_started'), word('g_cane', 'not_started'), word('g_sole', 'not_started')],
    });
    // The photos are one review, so i_b's gatto is i_a's: saved once. Then the typed words.
    expect(inserted).toEqual([
      ['g_casa', 'g_gatto', 'g_cane'],
      ['g_cane', 'g_sole'],
    ]);
    expect(saved).toEqual(['g_casa', 'g_gatto', 'g_cane', 'g_sole']);
    expect(transitions).toEqual([
      ['i_a', ['read'], 'saved'],
      ['i_b', ['read'], 'saved'],
    ]);
    expect(created).toEqual([{ enrollmentId: 'e1', kind: 'exam', dueOn: DUE }]);
    expect(events).toEqual([
      {
        targetId: 't_new',
        kind: 'created',
        before: null,
        after: { kind: 'exam', due_on: DUE, gloss_ids: ['g_casa', 'g_gatto', 'g_cane', 'g_sole'] },
        actorUserId: OWNER,
        sessionId: null,
      },
    ]);
    expect(jobs.enqueued.at(-1)).toEqual(TARGET_STOCK);
    // Each photo's save as its own logs it, counting the words it gave: gatto is i_a's.
    expect(logger.events).toEqual([
      importSaved('i_a', 2),
      importSaved('i_b', 1),
      { event: 'target_created', enrollment_id: 'e1', target_id: 't_new', kind: 'exam', word_count: 4, unread_photo_count: 0 },
    ]);
  });

  it('logs each photo saved with what its review left, and the photos not read on target_created (final review I3)', async () => {
    const reviewed = photo('i_a', ['g_casa', 'g_gatto']);
    // gatto unticked; cane's row read as sole, its other meaning chosen instead.
    reviewed.items[1] = { ...reviewed.items[1], ticked: false };
    reviewed.items.push({
      ...itemRow('i_a', 2, 'g_cane'),
      options: [...itemRow('i_a', 2, 'g_sole').options, ...itemRow('i_a', 2, 'g_cane').options],
      suggestedGlossId: 'g_sole',
    });
    const { service, logger } = world({ imports: [photo('i_failed', [], { status: 'failed' }), reviewed] });

    await service.create(OWNER, 'e1', createRequest({ photo_import_ids: ['i_failed', 'i_a'], entries: [] }));

    expect(logger.events).toEqual([
      importSaved('i_a', 2, 1, 1),
      { event: 'target_created', enrollment_id: 'e1', target_id: 't_new', kind: 'exam', word_count: 2, unread_photo_count: 1 },
    ]);
  });

  it('takes a gloss from the first photo that has it: unticked there, it is not saved from a later photo (ruling R-D9)', async () => {
    const first = photo('i_a', ['g_gatto', 'g_casa']);
    first.items[0] = { ...first.items[0], ticked: false };
    const { service, saved } = world({ imports: [first, photo('i_b', ['g_gatto'])] });

    const made = await service.create(OWNER, 'e1', createRequest({ photo_import_ids: ['i_a', 'i_b'], entries: [] }));

    expect(made.words.map((kept) => kept.gloss_id)).toEqual(['g_casa']);
    expect(saved).toEqual(['g_casa']);
  });

  it('skips a photo that could not be read, and saves the rest (Review Focus 4)', async () => {
    const { service, transitions } = world({ imports: [photo('i_failed', [], { status: 'failed' }), photo('i_a', ['g_casa'])] });

    const made = await service.create(OWNER, 'e1', createRequest({ photo_import_ids: ['i_failed', 'i_a'], entries: [] }));

    expect(made.words.map((kept) => kept.gloss_id)).toEqual(['g_casa']);
    expect(transitions).toEqual([['i_a', ['read'], 'saved']]);
  });

  it.each<[string, SeededImport]>([
    ['still reading', photo('i_x', [], { status: 'reading' })],
    ['still looking a row up', { row: importRow('i_x'), items: [itemRow('i_x', 0, 'g_casa', { status: 'pending' })] }],
    ['saved already', photo('i_x', ['g_casa'], { status: 'saved' })],
    ['discarded', photo('i_x', ['g_casa'], { status: 'discarded' })],
    ['expired', photo('i_x', ['g_casa'], { createdAt: new Date(NOW - IMPORT_TTL_MS) })],
  ])('refuses a photo import %s with PhotoImportConflict, and makes no target (Review Focus 4)', async (_state, seeded) => {
    const { service, created, transitions } = world({ imports: [seeded] });
    await expect(service.create(OWNER, 'e1', createRequest({ photo_import_ids: ['i_x'] }))).rejects.toBeInstanceOf(PhotoImportConflict);
    expect(created).toEqual([]);
    expect(transitions).toEqual([]);
  });

  it.each<[string, SeededImport[]]>([
    ['of another list', [photo('i_x', ['g_casa'], { enrollmentId: 'e2' })]],
    ['that does not exist', []],
  ])('refuses a photo import %s with PhotoImportNotFound (Review Focus 4)', async (_which, imports) => {
    const { service, created } = world({ imports });
    await expect(service.create(OWNER, 'e1', createRequest({ photo_import_ids: ['i_x'] }))).rejects.toBeInstanceOf(PhotoImportNotFound);
    expect(created).toEqual([]);
  });

  it.each<[string, DayContext, string]>([
    ['today', { kind: 'learner', timeZone: 'UTC' }, TODAY],
    ['a day before today', { kind: 'learner', timeZone: 'UTC' }, '2026-10-14'],
    // At 09:00 UTC it is still the 14th in Honolulu: that is the learner's today there.
    ['today in the learner’s own time zone', { kind: 'learner', timeZone: 'Pacific/Honolulu' }, '2026-10-14'],
    ['a bot’s day', { kind: 'bot', day: '2030-01-08' }, '2030-01-08'],
  ])('refuses a due date of %s with InvalidTarget(due_date), before anything is saved (Review Focus 5)', async (_which, day, dueOn) => {
    const { service, saved, created, calls } = world({ day });
    const refusal = service.create(OWNER, 'e1', createRequest({ due_on: dueOn }));
    await expect(refusal).rejects.toBeInstanceOf(InvalidTarget);
    await expect(refusal).rejects.toMatchObject({ reason: 'due_date' });
    expect(saved).toEqual([]);
    expect(created).toEqual([]);
    expect(calls).not.toContain('lockNextSession');
  });

  it('counts from the learner’s own day: in Honolulu the 15th is still a day off', async () => {
    const { service } = world({ day: { kind: 'learner', timeZone: 'Pacific/Honolulu' } });
    const made = await service.create(OWNER, 'e1', createRequest({ due_on: TODAY }));
    expect(made).toMatchObject({ due_on: TODAY, days_left: 1 });
  });

  it('takes the date from the bot’s day, not the clock: the day after it is one day left', async () => {
    const { service } = world({ day: { kind: 'bot', day: '2030-01-08' } });
    const made = await service.create(OWNER, 'e1', createRequest({ due_on: '2030-01-09' }));
    expect(made).toMatchObject({ due_on: '2030-01-09', days_left: 1 });
  });

  it.each<[string, Partial<CreateTargetRequest>, SeededImport[]]>([
    ['only a photo that could not be read', { photo_import_ids: ['i_failed'], entries: [] }, [photo('i_failed', [], { status: 'failed' })]],
    ['a photo whose every row is unticked', { photo_import_ids: ['i_a'], entries: [] }, [{ row: importRow('i_a'), items: [itemRow('i_a', 0, 'g_casa', { ticked: false })] }]],
    ['nothing at all', { photo_import_ids: [], entries: [] }, []],
  ])('refuses a target with no word, from %s, with InvalidTarget(no_words) (ruling R-D10)', async (_from, request, imports) => {
    const { service, created } = world({ imports });
    const refusal = service.create(OWNER, 'e1', createRequest(request));
    await expect(refusal).rejects.toBeInstanceOf(InvalidTarget);
    await expect(refusal).rejects.toMatchObject({ reason: 'no_words' });
    expect(created).toEqual([]);
  });

  it('answers EnrollmentNotFound for a list that does not exist', async () => {
    const { service } = world();
    await expect(service.create(OWNER, 'e_none', createRequest())).rejects.toBeInstanceOf(EnrollmentNotFound);
  });

  it('takes the next-session lock before it locks an import or writes anything', async () => {
    const { service, calls } = world({ imports: [photo('i_a', ['g_casa'])] });
    await service.create(OWNER, 'e1', createRequest({ photo_import_ids: ['i_a'] }));
    expect(calls.indexOf('lockNextSession')).toBeLessThan(calls.indexOf('findImportForUpdate i_a'));
    expect(calls.indexOf('findImportForUpdate i_a')).toBeLessThan(calls.indexOf('insertTarget'));
  });
});

describe('the stock a change leaves (ruling R-D12b, Review Focus 3)', () => {
  it('retires the unstarted list stock, logs it, and asks for the next, in the change’s transaction', async () => {
    const { service, retired, jobs, logger, calls } = world({ open: { stock: listStock() } });

    await service.create(OWNER, 'e1', createRequest());

    expect(retired).toEqual(['s_stock']);
    expect(calls.indexOf('insertTarget')).toBeLessThan(calls.indexOf('retireStock'));
    expect(jobs.enqueued.at(-1)).toEqual(TARGET_STOCK);
    expect(logged(logger, 'session_retired')).toEqual([
      { event: 'session_retired', enrollment_id: 'e1', session_id: 's_stock', reason: 'target_changed' },
    ]);
  });

  it.each<[string, { started?: SessionSummary; stock?: SessionSummary }]>([
    ['a started session', { started: { ...listStock('s_started'), answered: 3 } }],
    ['the seed in stock', { stock: { ...listStock('s_seed'), source: 'seed' } }],
    ['no session at all', {}],
  ])('leaves %s alone, and still asks for the next stock', async (_which, open) => {
    const { service, retired, jobs, logger } = world({ open });
    await service.create(OWNER, 'e1', createRequest());
    expect(retired).toEqual([]);
    expect(jobs.enqueued.at(-1)).toEqual(TARGET_STOCK);
    expect(logged(logger, 'session_retired')).toEqual([]);
  });

  it('logs no retirement when a start took the stock first', async () => {
    const { service, retired, jobs, logger } = world({ open: { stock: listStock() }, retires: false });
    await service.create(OWNER, 'e1', createRequest());
    expect(retired).toEqual(['s_stock']);
    expect(jobs.enqueued.at(-1)).toEqual(TARGET_STOCK);
    expect(logged(logger, 'session_retired')).toEqual([]);
  });
});

describe('addWords', () => {
  it('saves the words, adds those the target lacks, and logs words_added with only them', async () => {
    const { service, events, logger, retired, jobs } = world({
      saved: ['g_casa'],
      targets: [target({ words: ['g_casa'] })],
      imports: [photo('i_a', ['g_casa', 'g_gatto'])],
      open: { stock: listStock() },
    });

    const changed = await service.addWords(OWNER, 't1', { photo_import_ids: ['i_a'], entries: [entry('g_cane')] });

    expect(changed.words.map((kept) => kept.gloss_id)).toEqual(['g_casa', 'g_gatto', 'g_cane']);
    expect(changed.word_count).toBe(3);
    expect(events).toEqual([
      { targetId: 't1', kind: 'words_added', before: null, after: { gloss_ids: ['g_gatto', 'g_cane'] }, actorUserId: OWNER, sessionId: null },
    ]);
    expect(retired).toEqual(['s_stock']);
    expect(jobs.enqueued.at(-1)).toEqual(TARGET_STOCK);
    expect(logger.events).toEqual([
      importSaved('i_a', 2, 0, 0, 't1'),
      { event: 'target_changed', target_id: 't1', change: 'words_added', count: 2, unread_photo_count: 0 },
      { event: 'session_retired', enrollment_id: 'e1', session_id: 's_stock', reason: 'target_changed' },
    ]);
  });

  it('logs the photos saved and those not read; a photo whose words the target holds is saved and logged all the same (final review I3)', async () => {
    const { service, logger } = world({
      saved: ['g_casa'],
      targets: [target({ words: ['g_casa'] })],
      imports: [photo('i_failed', [], { status: 'failed' }), photo('i_a', ['g_gatto']), photo('i_b', ['g_casa'])],
    });

    await service.addWords(OWNER, 't1', { photo_import_ids: ['i_failed', 'i_a', 'i_b'], entries: [] });

    expect(logger.events).toEqual([
      importSaved('i_a', 1, 0, 0, 't1'),
      importSaved('i_b', 1, 0, 0, 't1'),
      { event: 'target_changed', target_id: 't1', change: 'words_added', count: 1, unread_photo_count: 1 },
    ]);
  });

  it('logs a photo saved though it added the target no word: no target_changed (final review I3)', async () => {
    const { service, logger, events } = world({ saved: ['g_casa'], targets: [target()], imports: [photo('i_a', ['g_casa'])], open: { stock: listStock() } });
    await service.addWords(OWNER, 't1', { photo_import_ids: ['i_a'], entries: [] });
    expect(events).toEqual([]);
    expect(logger.events).toEqual([importSaved('i_a', 1, 0, 0, 't1')]);
  });

  it('changes nothing when the target holds every word already: no event, the stock kept', async () => {
    const { service, events, retired, logger } = world({ saved: ['g_casa'], targets: [target()], open: { stock: listStock() } });
    const changed = await service.addWords(OWNER, 't1', { photo_import_ids: [], entries: [entry('g_casa')] });
    expect(changed.words.map((kept) => kept.gloss_id)).toEqual(['g_casa']);
    expect(events).toEqual([]);
    expect(retired).toEqual([]);
    expect(logger.events).toEqual([]);
  });

  it.each<[string, StoredTarget]>([
    ['ended early', target({ endedAt: new Date(NOW - 3_600_000) })],
    ['whose date has come', target({ dueOn: TODAY })],
  ])('refuses a target %s with TargetClosed, before anything is saved', async (_which, closed) => {
    const { service, saved, events } = world({ targets: [closed], imports: [photo('i_a', ['g_gatto'])] });
    await expect(service.addWords(OWNER, 't1', { photo_import_ids: ['i_a'], entries: [entry('g_cane')] })).rejects.toBeInstanceOf(TargetClosed);
    expect(saved).toEqual([]);
    expect(events).toEqual([]);
  });

  it('refuses a photo import saved already with PhotoImportConflict (Review Focus 4)', async () => {
    const { service, events } = world({ targets: [target()], imports: [photo('i_a', ['g_gatto'], { status: 'saved' })] });
    await expect(service.addWords(OWNER, 't1', { photo_import_ids: ['i_a'], entries: [] })).rejects.toBeInstanceOf(PhotoImportConflict);
    expect(events).toEqual([]);
  });

  it('answers TargetNotFound for a target that does not exist', async () => {
    const { service } = world();
    await expect(service.addWords(OWNER, 't_none', { photo_import_ids: [], entries: [entry('g_casa')] })).rejects.toBeInstanceOf(TargetNotFound);
  });

  it('takes the next-session lock before it locks the target: a stock being written holds the one and references the other', async () => {
    const { service, calls } = world({ targets: [target()] });
    await service.addWords(OWNER, 't1', { photo_import_ids: [], entries: [entry('g_gatto')] });
    expect(calls.slice(0, 3)).toEqual(['findTarget', 'lockNextSession', 'findTargetForUpdate']);
  });
});

describe('removeWord', () => {
  it('takes the word out, keeps it saved, logs words_removed, and retires the stock', async () => {
    const { service, stored, saved, events, retired, logger } = world({
      saved: ['g_casa', 'g_gatto'],
      targets: [target({ words: ['g_casa', 'g_gatto'] })],
      open: { stock: listStock() },
    });

    await service.removeWord(OWNER, 't1', 'g_casa');

    expect(stored.get('t1')!.words).toEqual(['g_gatto']);
    expect(saved).toEqual(['g_casa', 'g_gatto']);
    expect(events).toEqual([
      { targetId: 't1', kind: 'words_removed', before: { gloss_ids: ['g_casa'] }, after: { reason: 'removed' }, actorUserId: OWNER, sessionId: null },
    ]);
    expect(retired).toEqual(['s_stock']);
    expect(logged(logger, 'target_changed')).toEqual([{ event: 'target_changed', target_id: 't1', change: 'words_removed', count: 1 }]);
  });

  it('may leave a target with no word (ruling R-D10)', async () => {
    const { service, stored } = world({ saved: ['g_casa'], targets: [target({ words: ['g_casa'] })] });
    await service.removeWord(OWNER, 't1', 'g_casa');
    expect(stored.get('t1')!.words).toEqual([]);
  });

  it('is idempotent: a word the target does not hold changes nothing', async () => {
    const { service, events, retired, jobs, logger } = world({ targets: [target()], open: { stock: listStock() } });
    await service.removeWord(OWNER, 't1', 'g_gatto');
    expect(events).toEqual([]);
    expect(retired).toEqual([]);
    expect(jobs.enqueued).toEqual([]);
    expect(logger.events).toEqual([]);
  });

  it('refuses a target whose date has come with TargetClosed', async () => {
    const { service } = world({ targets: [target({ dueOn: '2026-10-10' })] });
    await expect(service.removeWord(OWNER, 't1', 'g_casa')).rejects.toBeInstanceOf(TargetClosed);
  });
});

describe('changeDate', () => {
  it('moves the date, logs date_changed with both, and answers the days left to the new one', async () => {
    const { service, stored, events, retired, logger } = world({ saved: ['g_casa'], targets: [target()], open: { stock: listStock() } });

    const changed = await service.changeDate(OWNER, 't1', { due_on: '2026-10-25' });

    expect(changed).toMatchObject({ id: 't1', due_on: '2026-10-25', days_left: 10 });
    expect(stored.get('t1')!.dueOn).toBe('2026-10-25');
    expect(events).toEqual([
      { targetId: 't1', kind: 'date_changed', before: { due_on: DUE }, after: { due_on: '2026-10-25' }, actorUserId: OWNER, sessionId: null },
    ]);
    expect(retired).toEqual(['s_stock']);
    expect(logged(logger, 'target_changed')).toEqual([{ event: 'target_changed', target_id: 't1', change: 'date_changed' }]);
  });

  it.each<[string, DayContext, string]>([
    ['today', { kind: 'learner', timeZone: 'UTC' }, TODAY],
    ['a day before today', { kind: 'learner', timeZone: 'UTC' }, '2026-10-01'],
    ['a bot’s day', { kind: 'bot', day: '2026-10-18' }, '2026-10-18'],
  ])('refuses a new date of %s with InvalidTarget(due_date), and changes nothing (Review Focus 5)', async (_which, day, dueOn) => {
    const { service, stored, events } = world({ day, targets: [target()] });
    const refusal = service.changeDate(OWNER, 't1', { due_on: dueOn });
    await expect(refusal).rejects.toBeInstanceOf(InvalidTarget);
    await expect(refusal).rejects.toMatchObject({ reason: 'due_date' });
    expect(stored.get('t1')!.dueOn).toBe(DUE);
    expect(events).toEqual([]);
  });

  it('changes nothing when the date is the one it has', async () => {
    const { service, events, retired } = world({ saved: ['g_casa'], targets: [target()], open: { stock: listStock() } });
    expect(await service.changeDate(OWNER, 't1', { due_on: DUE })).toMatchObject({ due_on: DUE, days_left: 5 });
    expect(events).toEqual([]);
    expect(retired).toEqual([]);
  });

  it('refuses an ended target with TargetClosed', async () => {
    const { service } = world({ targets: [target({ endedAt: new Date(NOW - 60_000) })] });
    await expect(service.changeDate(OWNER, 't1', { due_on: '2026-10-25' })).rejects.toBeInstanceOf(TargetClosed);
  });
});

describe('end', () => {
  it('ends the target now, logs ended_early and target_ended, and retires the stock', async () => {
    const { service, stored, events, retired, jobs, logger } = world({ targets: [target()], open: { stock: listStock() } });

    await service.end(OWNER, 't1');

    expect(stored.get('t1')!.endedAt).toEqual(new Date(NOW));
    expect(events).toEqual([
      { targetId: 't1', kind: 'ended_early', before: null, after: { due_on: DUE }, actorUserId: OWNER, sessionId: null },
    ]);
    expect(retired).toEqual(['s_stock']);
    expect(jobs.enqueued.at(-1)).toEqual(TARGET_STOCK);
    expect(logger.events).toEqual([
      { event: 'target_ended', target_id: 't1', how: 'early' },
      { event: 'session_retired', enrollment_id: 'e1', session_id: 's_stock', reason: 'target_changed' },
    ]);
  });

  it('is a no-op on a target ended already', async () => {
    const ended = new Date(NOW - 3_600_000);
    const { service, stored, events, retired, logger } = world({ targets: [target({ endedAt: ended })], open: { stock: listStock() } });
    await service.end(OWNER, 't1');
    expect(stored.get('t1')!.endedAt).toEqual(ended);
    expect(events).toEqual([]);
    expect(retired).toEqual([]);
    expect(logger.events).toEqual([]);
  });

  it('refuses a target whose date has come with TargetClosed: it ended on its date', async () => {
    const { service } = world({ targets: [target({ dueOn: TODAY })] });
    await expect(service.end(OWNER, 't1')).rejects.toBeInstanceOf(TargetClosed);
  });
});

describe('list and getTarget (spec D4, D11, rulings R-D4, R-D11)', () => {
  const READ = ['g_casa', 'g_lupo', 'g_gatto', 'g_cane', 'g_sole'];
  const MEMORY = [
    ...memory('g_casa', ALL_SKILLS, solid),
    // Never asked aloud, and too long to be: speaking does not count against it.
    ...memory('g_lupo', ALL_SKILLS.slice(0, 4), solid),
    // Never asked aloud, though it can be: while speaking is live, it counts 0.
    ...memory('g_gatto', ALL_SKILLS.slice(0, 4), solid),
    ...memory('g_sole', ALL_SKILLS, fading),
  ];

  it('reads each word’s readiness for the date in its weakest live skill, with the form saved and the key', async () => {
    const { service } = world({
      saved: READ,
      targets: [target({ words: READ })],
      memory: MEMORY,
      devices: { listening: true, speaking: true },
    });

    expect(await service.getTarget(OWNER, 't1')).toEqual({
      id: 't1',
      kind: 'exam',
      due_on: DUE,
      days_left: 5,
      word_count: 5,
      ready_count: 2,
      words: [
        word('g_casa', 'ready'),
        word('g_lupo', 'ready'),
        word('g_gatto', 'on_the_way'),
        word('g_cane', 'not_started'),
        word('g_sole', 'almost'),
      ],
    });
  });

  it('reads the bars of the target’s kind: what is "almost" for an exam is ready for homework', async () => {
    const { service } = world({ saved: READ, targets: [target({ kind: 'homework', words: READ })], memory: MEMORY, devices: { listening: true, speaking: true } });
    const homework = await service.getTarget(OWNER, 't1');
    expect(homework.words.find((kept) => kept.gloss_id === 'g_sole')?.readiness).toBe('ready');
    expect(homework.ready_count).toBe(3);
  });

  it('reads the live skills of the newest session: with no device to speak or listen, the spoken ones do not count', async () => {
    const { service } = world({ saved: READ, targets: [target({ words: READ })], memory: MEMORY });
    const read = await service.getTarget(OWNER, 't1');
    expect(read.words.find((kept) => kept.gloss_id === 'g_gatto')?.readiness).toBe('ready');
    expect(read.ready_count).toBe(3);
  });

  it('lists the active targets nearest date first, with today, and leaves out the ended, the past and another list’s', async () => {
    const { service } = world({
      saved: ['g_casa', 'g_gatto'],
      memory: memory('g_casa', ALL_SKILLS, solid),
      targets: [
        target({ id: 't_far', kind: 'homework', dueOn: '2026-11-01', words: ['g_casa', 'g_gatto'] }),
        target({ id: 't_near', dueOn: '2026-10-18', words: ['g_gatto'] }),
        target({ id: 't_ended', endedAt: new Date(NOW - 60_000) }),
        target({ id: 't_past', dueOn: TODAY }),
        target({ id: 't_other', enrollmentId: 'e2' }),
      ],
    });

    expect(await service.list(OWNER, 'e1')).toEqual({
      today: TODAY,
      targets: [
        { id: 't_near', kind: 'exam', due_on: '2026-10-18', days_left: 3, word_count: 1, ready_count: 0 },
        { id: 't_far', kind: 'homework', due_on: '2026-11-01', days_left: 17, word_count: 2, ready_count: 1 },
      ],
    });
  });

  it('lists none for a learner with no target', async () => {
    const { service } = world();
    expect(await service.list(OWNER, 'e1')).toEqual({ today: TODAY, targets: [] });
  });

  it('reads one target ended early, or past its date, too', async () => {
    const { service } = world({ saved: ['g_casa'], targets: [target({ dueOn: '2026-10-12', endedAt: new Date(NOW - 86_400_000 * 5) })] });
    expect(await service.getTarget(OWNER, 't1')).toMatchObject({ id: 't1', due_on: '2026-10-12', days_left: -3, word_count: 1 });
  });

  it('answers TargetNotFound for a target that does not exist', async () => {
    const { service } = world();
    await expect(service.getTarget(OWNER, 't_none')).rejects.toBeInstanceOf(TargetNotFound);
  });
});

describe('vocabulary.unsave (spec D1, Review Focus 2)', () => {
  it('takes an unsaved word out of every target it was in, each with words_removed (reason unsaved)', async () => {
    const { vocabularyService, stored, events, saved } = world({
      saved: ['g_casa', 'g_gatto'],
      targets: [target({ words: ['g_casa', 'g_gatto'] }), target({ id: 't2', words: ['g_casa'] }), target({ id: 't3', words: ['g_gatto'] })],
    });

    await vocabularyService.unsave(OWNER, 'e1', 'g_casa');

    expect(saved).toEqual(['g_gatto']);
    expect([...stored.values()].map((row) => [row.id, row.words])).toEqual([
      ['t1', ['g_gatto']],
      ['t2', []],
      ['t3', ['g_gatto']],
    ]);
    const removed = (targetId: string) => ({
      targetId,
      kind: 'words_removed',
      before: { gloss_ids: ['g_casa'] },
      after: { reason: 'unsaved' },
      actorUserId: OWNER,
      sessionId: null,
    });
    expect(events).toEqual([removed('t1'), removed('t2')]);
  });

  it('takes a merged-away gloss out as its survivor, the gloss the targets hold', async () => {
    const gloss = {
      ...createFakeGlossRepo(),
      resolveGlosses: async (ids: string[]) => new Map(ids.map((id) => [id, { id: 'g_casa', lexemeId: 'l_casa', userLanguageCode: 'he' }])),
    };
    const { vocabularyService, calls, events } = world({ saved: ['g_casa'], targets: [target()], gloss });

    await vocabularyService.unsave(OWNER, 'e1', 'g_old_casa');

    expect(calls).toEqual(['deleteEntry g_casa', 'removeGlossFromTargets g_casa', 'insertEvent words_removed']);
    expect(events.map((event) => event.before)).toEqual([{ gloss_ids: ['g_casa'] }]);
  });

  it('writes no event for a word in no target', async () => {
    const { vocabularyService, events } = world({ saved: ['g_gatto'], targets: [target()] });
    await vocabularyService.unsave(OWNER, 'e1', 'g_gatto');
    expect(events).toEqual([]);
  });
});

// Spec D2. A target is its learner's alone: anyone else, a tutor of the list included, is
// refused before anything is read past the check or written.
describe('authorization (spec D2)', () => {
  const asked = { photo_import_ids: ['i_a'], entries: [entry('g_gatto')] };
  it.each<[string, (service: TargetService, actor: string) => Promise<unknown>]>([
    ['list', (service, actor) => service.list(actor, 'e1')],
    ['getTarget', (service, actor) => service.getTarget(actor, 't1')],
    ['create', (service, actor) => service.create(actor, 'e1', createRequest(asked))],
    ['addWords', (service, actor) => service.addWords(actor, 't1', asked)],
    ['removeWord', (service, actor) => service.removeWord(actor, 't1', 'g_casa')],
    ['changeDate', (service, actor) => service.changeDate(actor, 't1', { due_on: '2026-10-25' })],
    ['end', (service, actor) => service.end(actor, 't1')],
  ])('%s refuses another learner and the list’s tutor with AccessDenied, and writes nothing', async (_useCase, call) => {
    for (const [actor, grant] of [
      [STRANGER, null],
      [TUTOR, { ownerUserId: OWNER, granteeUserId: TUTOR, role: 'tutor', accepted: true }],
    ] as const) {
      const { service, logger, calls, saved, transitions, events, created, retired, jobs } = world({
        targets: [target()],
        imports: [photo('i_a', ['g_casa'])],
        grant,
      });
      await expect(call(service, actor)).rejects.toBeInstanceOf(AccessDenied);
      expect(logger.events).toEqual([{ event: 'access_denied', actor_user_id: actor, enrollment_id: 'e1', permission: 'targets.manage' }]);
      expect(calls.filter((name) => name !== 'findTarget')).toEqual([]);
      expect([saved, transitions, events, created, retired, jobs.enqueued]).toEqual([[], [], [], [], [], []]);
    }
  });
});
