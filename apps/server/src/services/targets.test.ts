import { describe, expect, it } from '@jest/globals';
import type { CreateTargetRequest, Enrollment, VocabularyEntryInput } from '@lang-tutor/core/api';
import { FSRS6_DEFAULT, readinessFromMemory, type Dimension, type MemoryState, type ReadinessRow } from '@lang-tutor/core/domain';

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
import type { Devices, SessionSummary } from '../domain/session';
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
import type { ProgressRepo } from '../repo/progress';
import type { SessionRepo } from '../repo/sessions';
import type { TargetEventInput, TargetRow } from '../repo/targets';
import type { TargetSkillRepo } from '../repo/targetSkills';
import type { TargetSkillRow } from '../domain/targetSkills';
import type { TargetReadinessRow } from '../domain/readinessWrite';
import type { TargetBudget } from '../domain/targetBudget';
import type { DayAnswer } from '../domain/today';
import type { TargetBudgetRepo } from '../repo/targetBudgets';
import type { TargetReadinessRepo } from '../repo/targetReadiness';
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
  // Written with a capital: the saved list's own read lowercases it (final review M3).
  g_roma: { variantId: 'v_roma', lexemeId: 'l_roma', lemma: 'Roma', form: 'Roma', key: 'רומא' },
};
const entry = (glossId: string): VocabularyEntryInput => ({ gloss_id: glossId, variant_id: WORDS[glossId].variantId });

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
/** Phase 65. A target's readiness rows for `glossId`, each skill read from `state`. */
const readinessRows = (
  glossId: string,
  dimensions: readonly Dimension[],
  state: MemoryState,
  over: Partial<ReadinessRow> = {},
  targetId = 't1',
): TargetReadinessRow[] =>
  dimensions.map((dimension) => ({ targetId, glossId, dimension, row: { ...readinessFromMemory(state), ...over }, sessionId: null }));

const listStock = (id = 's_stock'): SessionSummary => ({ id, status: 'ready', source: 'list', answered: 0, total: 10 });
/** Phase 57 (spec D2). A change asks for the main path's next stock, then for its target's. */
const MAIN_STOCK = { name: STOCK_SESSION, data: { enrollment_id: 'e1', reason: 'target' }, options: { singletonKey: 'e1' } };
const targetStock = (targetId: string) => ({
  name: STOCK_SESSION,
  data: { enrollment_id: 'e1', reason: 'target', target_id: targetId },
  options: { singletonKey: `e1:${targetId}` },
});
const restocked = (targetId: string) => [MAIN_STOCK, targetStock(targetId)];

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
    /** The main path's open sessions. */
    open?: { started?: SessionSummary; stock?: SessionSummary };
    /** Phase 57. Each target path's open sessions, by target id; none when not given. */
    openOn?: Record<string, { started?: SessionSummary; stock?: SessionSummary }>;
    /** Phase 57 (spec D13). Each target path's newest session, by target id. */
    latestOn?: Record<string, SessionSummary>;
    /** Phase 58. The saved glosses a level's removal finds at its level. */
    atLevel?: string[];
    /** Phase 57. The target skills rows read. */
    skills?: TargetSkillRow[];
    /** Phase 57. The day each target word started, by gloss id; none when not given. */
    startedOn?: Record<string, string>;
    /** Phase 57. The answers of the learner's today, each with its session's path. */
    answersOn?: (DayAnswer & { targetId: string | null })[];
    /** Phase 65. The target readiness rows read. */
    readiness?: TargetReadinessRow[];
    /** Phase 65. Each target's first readiness lines of a day, by `${targetId}|${day}`. */
    firstEvents?: Record<string, { glossId: string; dimension: Dimension; before: number }[]>;
    /** Phase 65. Each target's stored budget, by `${targetId}|${day}`. */
    budgets?: Record<string, TargetBudget>;
    /** Phase 65. Each path's sessions completed on a day, by `${path}|${day}` (the main path's is null). */
    completed?: Record<string, number>;
    /** Final review I1-c. When each session was last answered; none when not given. */
    lastAnswerAt?: Record<string, Date>;
    /** Whether retireStock finds the stock still unstarted; false when a start took it first. */
    retires?: boolean;
    gloss?: Repos['gloss'];
    grant?: Awaited<ReturnType<GrantRepo['findGrantFor']>>;
  } = {},
) {
  const calls: string[] = [];
  /** Phase 65. The reads a target's summary made that a test checks, apart from `calls`. */
  const reads: string[] = [];
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
    findGlossIdsAtLevel: async () => (setup.atLevel ?? []).map((glossId) => ({ lemma: WORDS[glossId].lemma, glossId })),
    // Phase 58b (R2). Every saved gloss, as removing every word reads them.
    findAllSavedGlossIds: async () => saved.map((glossId) => ({ lemma: WORDS[glossId].lemma, glossId })),
    deleteEntries: async ({ glossIds }) => {
      calls.push(`deleteEntries ${glossIds.join(' ')}`);
      for (const glossId of glossIds) if (saved.includes(glossId)) saved.splice(saved.indexOf(glossId), 1);
    },
    // A target's words, as the repository reads them, keep the form as saved (final review M3).
    // The saved list (listSavedGlosses), which lowercases it, is not stubbed: a target is read
    // from its own words alone.
    findSavedWords: async ({ glossIds }) =>
      saved.filter((glossId) => glossIds.includes(glossId)).map((glossId) => ({ glossId, key: WORDS[glossId].key, form: WORDS[glossId].form })),
    // Phase 65 (spec D7.1). The saved list as a target's picker reads it, for today's budget.
    listSavedGlosses: async () => {
      reads.push('listSavedGlosses');
      return saved.map((glossId, i) => ({
        glossId,
        key: WORDS[glossId].key,
        variantId: WORDS[glossId].variantId,
        savedAt: '2026-10-01T00:00:00.000Z',
        lexemeId: WORDS[glossId].lexemeId,
        lemma: WORDS[glossId].lemma,
        form: WORDS[glossId].form.toLowerCase(),
        order: [i, 0] as [number, number],
        knownAt: null,
      }));
    },
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
        .filter((row) => row.enrollmentId === enrollmentId && row.dueOn >= today && row.endedAt === null)
        .sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.id.localeCompare(b.id))
        .map((row) => ({ ...plain(row), glossIds: [...row.words] })),
    listWordIds: async (id) => [...(stored.get(id)?.words ?? [])],
    listWords: async (id) =>
      (stored.get(id)?.words ?? []).map((glossId) => ({
        glossId,
        addedAt: stored.get(id)!.createdAt,
        startedOn: setup.startedOn?.[glossId] ?? null,
      })),
    listHolding: async (enrollmentId, glossId) =>
      [...stored.values()]
        .filter((row) => row.enrollmentId === enrollmentId && row.words.includes(glossId))
        .map((row) => row.id)
        .sort(),
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
    removeGlossesFromTargets: async (enrollmentId, glossIds) => {
      calls.push(`removeGlossesFromTargets ${glossIds.join(' ')}`);
      const lost = new Map<string, string[]>();
      for (const row of [...stored.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        const gone = row.words.filter((word) => glossIds.includes(word));
        if (row.enrollmentId !== enrollmentId || gone.length === 0) continue;
        row.words = row.words.filter((word) => !glossIds.includes(word));
        lost.set(row.id, gone.sort());
      }
      return lost;
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
    lockNextSession: async (_enrollmentId, path) => {
      calls.push(`lockNextSession ${path ?? 'main'}`);
    },
    // Final review I1. A started session skipped: its row changes, then its answers count.
    transition: async (sessionId, from, to, day) => {
      calls.push(`transition ${sessionId} ${from.join('|')} ${to} ${day}`);
      return true;
    },
    resolvePendingRetry: async (sessionId) => {
      calls.push(`resolvePendingRetry ${sessionId}`);
    },
    findLastAnswerAt: async (sessionId) => setup.lastAnswerAt?.[sessionId] ?? null,
    findOpen: async (_enrollmentId, path) => (path === null ? (setup.open ?? {}) : (setup.openOn?.[path] ?? {})),
    retireStock: async (sessionId) => {
      calls.push('retireStock');
      retired.push(sessionId);
      return setup.retires ?? true;
    },
    findNewestDevices: async () => setup.devices,
    findAnswersOn: async () => {
      reads.push('findAnswersOn');
      return setup.answersOn ?? [];
    },
    findLatest: async (_enrollmentId, path) => (path === null ? undefined : setup.latestOn?.[path]),
    // Phase 65 (spec D7). What today's budget and its sessions done read.
    countCompletedOn: async (_enrollmentId, path, day) => {
      reads.push(`countCompletedOn ${path}`);
      return setup.completed?.[`${path}|${day}`] ?? 0;
    },
    findRecentAnswers: async () => {
      reads.push('findRecentAnswers');
      return [];
    },
    findIntroducedOn: async () => [],
    findSessionCards: async () => [],
  });

  const transaction = createFakeTransaction({
    enrollment: stub<EnrollmentRepo>({ findById: async (id) => [ENROLLMENT, OTHER_LIST].find((enrolled) => enrolled.id === id) }),
    grant: stub<GrantRepo>({ findGrantFor: async () => setup.grant ?? null }),
    user: stub<UserRepo>({ findDayContext: async () => setup.day ?? { kind: 'learner' as const, timeZone: 'UTC' }, findNewWordLimits: async () => ({ dayCap: null, perSession: null }) }),
    vocabulary,
    photoImport,
    target,
    session,
    // Phase 57 (ruling T4-k). A removal waits for a session end.
    progress: stub<ProgressRepo>({
      // Phase 65 (spec D7.1). The levels a target's picker reads, for today's budget.
      findRows: async () => [],
      lockEnrollment: async () => {
        calls.push('lockEnrollment');
      },
      lockSessionGlosses: async () => {},
      // A skipped session with no answer writes no progress.
      findSessionEvidence: async (sessionId) => {
        calls.push(`findSessionEvidence ${sessionId}`);
        return undefined;
      },
    }),
    targetSkills: stub<TargetSkillRepo>({ findRows: async () => setup.skills ?? [] }),
    targetReadiness: stub<TargetReadinessRepo>({
      findRows: async (targetIds, glossIds) =>
        (setup.readiness ?? []).filter((row) => targetIds.includes(row.targetId) && glossIds.includes(row.glossId)),
      findFirstEventsOn: async (targetId, day) => setup.firstEvents?.[`${targetId}|${day}`] ?? [],
    }),
    targetBudgets: stub<TargetBudgetRepo>({ find: async (targetId, day) => setup.budgets?.[`${targetId}|${day}`] }),
    memory: stub<MemoryRepo>({
      findRows: async ({ glossIds }) => (setup.memory ?? []).filter((row) => glossIds.includes(row.glossId)),
    }),
    gloss: setup.gloss ?? createFakeGlossRepo(),
    dict: stub<DictRepo>({ claimLemmaRenders: async () => [], findLexemeForms: async () => [] }),
    // Phase 57 (ADR 0014 R4). Each enqueue named in `calls` by its key, so a test can check
    // that a removal asks for stocks only after the progress lock.
    jobs: {
      ...jobs,
      enqueue: async (name, data, options) => {
        calls.push(`enqueue ${options?.singletonKey ?? name}`);
        await jobs.enqueue(name, data, options);
      },
    },
  });
  const service = createTargetService({ transaction, logger, now: createFakeClock(NOW), stockSaveDelaySeconds: 30 });
  const vocabularyService = createVocabularyService({ transaction, logger, now: createFakeClock(NOW), stockSaveDelaySeconds: 30 });
  return { service, vocabularyService, logger, jobs, calls, reads, saved, inserted, transitions, stored, events, created, retired };
}

const createRequest = (over: Partial<CreateTargetRequest> = {}): CreateTargetRequest => ({
  kind: 'exam',
  due_on: DUE,
  photo_import_ids: [],
  entries: [entry('g_casa')],
  ...over,
});
const word = (glossId: string, over: Record<string, unknown> = {}) =>
  expect.objectContaining({ gloss_id: glossId, form: WORDS[glossId].form, meaning: WORDS[glossId].key, ...over });
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

    // Phase 57 (spec D6): five days, two of the four words planned for today (the words added
    // together go by gloss id), the others later.
    expect(made).toEqual({
      id: 't_new',
      kind: 'exam',
      due_on: DUE,
      created_on: TODAY,
      days_left: 5,
      word_count: 4,
      ready_count: 0,
      readiness_pct: 0,
      readiness_start_pct: 0,
      // Phase 65b D1: an exam five days out asks before practice more (the app asks once today is done).
      // Phase 67b (spec D6): its words are not met yet, so another session can raise the card.
      practice_more_little: false,
      word_readiness: [0, 0, 0, 0],
      today: {
        state: 'owed',
        done: 0,
        planned: 2,
        extra: 0,
        next_practice_in: 1,
        // Phase 65 (spec D7): no session yet, so no budget, and the offer is the one it would be.
        sessions_budget: null,
        sessions_offer: expect.any(Number),
        sessions_done: 0,
        ended_early: false,
        minutes: expect.any(Number),
      },
      session: null,
      words: [
        word('g_casa', { today: 'owed', starts_in: null }),
        word('g_gatto', { today: 'later', starts_in: 1 }),
        word('g_cane', { today: 'owed', starts_in: null }),
        word('g_sole', { today: 'later', starts_in: 2 }),
      ],
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
    expect(jobs.enqueued.slice(-2)).toEqual(restocked('t_new'));
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
    expect(calls.filter((call) => call.startsWith('lockNextSession'))).toEqual([]);
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
    expect(calls.indexOf('lockNextSession main')).toBeLessThan(calls.indexOf('findImportForUpdate i_a'));
    expect(calls.indexOf('findImportForUpdate i_a')).toBeLessThan(calls.indexOf('insertTarget'));
  });
});

describe('the stock a change leaves (ruling R-D12b, Review Focus 3)', () => {
  it('retires the unstarted list stock, logs it, and asks for the next, in the change’s transaction', async () => {
    const { service, retired, jobs, logger, calls } = world({ open: { stock: listStock() } });

    await service.create(OWNER, 'e1', createRequest());

    expect(retired).toEqual(['s_stock']);
    expect(calls.indexOf('insertTarget')).toBeLessThan(calls.indexOf('retireStock'));
    expect(jobs.enqueued.slice(-2)).toEqual(restocked('t_new'));
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
    expect(jobs.enqueued.slice(-2)).toEqual(restocked('t_new'));
    expect(logged(logger, 'session_retired')).toEqual([]);
  });

  it('logs no retirement when a start took the stock first', async () => {
    const { service, retired, jobs, logger } = world({ open: { stock: listStock() }, retires: false });
    await service.create(OWNER, 'e1', createRequest());
    expect(retired).toEqual(['s_stock']);
    expect(jobs.enqueued.slice(-2)).toEqual(restocked('t_new'));
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
    expect(jobs.enqueued.slice(-2)).toEqual(restocked('t1'));
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

  it("takes the next-session locks, the main path's then the target's, before it locks the target: a stock being written holds the one and references the other", async () => {
    const { service, calls } = world({ targets: [target()] });
    await service.addWords(OWNER, 't1', { photo_import_ids: [], entries: [entry('g_gatto')] });
    expect(calls.slice(0, 4)).toEqual(['findTarget', 'lockNextSession main', 'lockNextSession t1', 'findTargetForUpdate']);
  });
});

describe('removeWord', () => {
  it("takes the word out, keeps it saved, logs words_removed, and retires the stocks: the main path's and the target's", async () => {
    const { service, stored, saved, events, retired, logger, calls } = world({
      saved: ['g_casa', 'g_gatto'],
      targets: [target({ words: ['g_casa', 'g_gatto'] })],
      open: { stock: listStock() },
      openOn: { t1: { stock: listStock('s_own') } },
    });

    await service.removeWord(OWNER, 't1', 'g_casa');

    expect(stored.get('t1')!.words).toEqual(['g_gatto']);
    expect(saved).toEqual(['g_casa', 'g_gatto']);
    expect(events).toEqual([
      { targetId: 't1', kind: 'words_removed', before: { gloss_ids: ['g_casa'] }, after: { reason: 'removed' }, actorUserId: OWNER, sessionId: null },
    ]);
    expect(retired).toEqual(['s_stock', 's_own']);
    // Ruling T4-k, ADR 0014 R4: the progress lock once the stocks are retired (a skip of one
    // holds its row, then that lock), before the word goes, and before the next stocks are
    // asked for (a session end holds that lock, then enqueues its path's stock).
    expect(calls.slice(calls.indexOf('findTargetForUpdate') + 1)).toEqual([
      'retireStock',
      'retireStock',
      'lockEnrollment',
      'insertEvent words_removed',
      'enqueue e1',
      'enqueue e1:t1',
    ]);
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
    expect(jobs.enqueued.slice(-2)).toEqual(restocked('t1'));
    expect(logger.events).toEqual([
      { event: 'target_ended', target_id: 't1', how: 'early' },
      { event: 'session_retired', enrollment_id: 'e1', session_id: 's_stock', reason: 'target_changed' },
    ]);
  });

  // Final review I1, ADR 0014 R4. Its path's started session would otherwise stay open forever,
  // its words answered and met "today" every day: it is skipped in the end's transaction, its
  // answers counted once as a skip's, in R4's order: the paths' locks, the target's row, the
  // stocks retired and the session's row, the progress lock, then the stocks asked for.
  it("skips its path's started session, its answers counted once, in ADR 0014 R4's order", async () => {
    const { service, calls, retired, logger } = world({
      targets: [target()],
      open: { stock: listStock() },
      openOn: { t1: { started: { ...listStock('s_started'), answered: 3 }, stock: listStock('s_t1') } },
    });

    await service.end(OWNER, 't1');

    expect(retired).toEqual(['s_stock', 's_t1']);
    expect(calls).toEqual([
      'findTarget',
      'lockNextSession main',
      'lockNextSession t1',
      'findTargetForUpdate',
      'insertEvent ended_early',
      'retireStock',
      'retireStock',
      `transition s_started preparing|ready skipped ${TODAY}`,
      'resolvePendingRetry s_started',
      'lockEnrollment',
      'findSessionEvidence s_started',
      'enqueue e1',
      'enqueue e1:t1',
    ]);
    expect(logged(logger, 'session_skipped')).toEqual([{ event: 'session_skipped', session_id: 's_started', reason: 'target_ended' }]);
  });

  // Correction (ruling I1-c). The skip counts for the learner day of its last answer, so the
  // reviews it writes are dated when they were given: here, the day before.
  it("counts the skip for the day of the session's last answer", async () => {
    const { service, calls } = world({
      targets: [target()],
      openOn: { t1: { started: { ...listStock('s_started'), answered: 2 } } },
      lastAnswerAt: { s_started: new Date('2026-10-14T20:00:00Z') },
    });
    await service.end(OWNER, 't1');
    expect(calls).toContain('transition s_started preparing|ready skipped 2026-10-14');
  });

  it('skips nothing when its path has no started session', async () => {
    const { service, calls } = world({ targets: [target()], openOn: { t1: { stock: listStock('s_t1') } } });
    await service.end(OWNER, 't1');
    expect(calls.filter((call) => call.startsWith('transition') || call === 'lockEnrollment')).toEqual([]);
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

  it('reads each word’s day, its state and what it owes, and its readiness: its chance and its counted skills’ (phase 65, spec D10)', async () => {
    const { service } = world({
      saved: ['g_casa', 'g_gatto', 'g_cane'],
      targets: [target({ words: ['g_casa', 'g_gatto', 'g_cane'] })],
      // Phase 67 (spec D2): g_casa, met yesterday and ready, rests today.
      startedOn: { g_casa: '2026-10-14' },
      readiness: [...readinessRows('g_casa', ALL_SKILLS, solid), ...readinessRows('g_gatto', ['spelling'], fading)],
      devices: { listening: true, speaking: true },
    });

    const read = await service.getTarget(OWNER, 't1');

    // An exam asks write and spell: 0.99925 each on DUE.
    expect(read.words[0]).toEqual({
      gloss_id: 'g_casa',
      form: 'casa',
      meaning: WORDS.g_casa.key,
      // 99, past the homework bar: counted 100 (phase 67b D2).
      readiness_pct: 100,
      today: 'done',
      owed: [],
      starts_in: null,
      skills: [
        { dimension: 'written_productive', chance: 99, held: false },
        { dimension: 'spelling', chance: 99, held: false },
      ],
    });
    // Written productive never answered, with no memory: 0, and so is the word.
    expect(read.words[1]).toMatchObject({
      gloss_id: 'g_gatto',
      readiness_pct: 0,
      skills: [
        { dimension: 'written_productive', chance: 0, held: false },
        { dimension: 'spelling', chance: 84, held: false },
      ],
    });
  });

  it('counts a word ready at 90 and above, reading a skill with no readiness row from the main memory (spec D4, R1)', async () => {
    const { service } = world({
      saved: READ,
      targets: [target({ words: READ })],
      memory: MEMORY,
      devices: { listening: true, speaking: true },
    });

    const read = await service.getTarget(OWNER, 't1');

    // casa, lupo and gatto at 0.9985 (write and spell, from memory), each counted 100 (phase 67b
    // D2); sole at its weakest skill, 0.846; cane never met: three ready.
    expect(read.words.map((w) => [w.gloss_id, w.readiness_pct])).toEqual([
      ['g_casa', 100],
      ['g_lupo', 100],
      ['g_gatto', 100],
      ['g_cane', 0],
      ['g_sole', 84],
    ]);
    expect(read.ready_count).toBe(3);
    // (100 × 3 + 0 + 84) / 5 = 76.8.
    expect(read.readiness_pct).toBe(76);
  });

  it('answers the target path’s session: the started one, else the stock, else a failed newest, else none', async () => {
    const started = { ...listStock('s_started'), status: 'ready' as const, answered: 2 };
    const failed: SessionSummary = { id: 's_failed', status: 'failed', source: 'list', answered: 0, total: 0 };
    const done: SessionSummary = { id: 's_done', status: 'completed', source: 'list', answered: 5, total: 5 };
    const sessionOf = async (setup: Parameters<typeof world>[0]) =>
      (await world({ saved: ['g_casa'], targets: [target()], ...setup }).service.getTarget(OWNER, 't1')).session;

    expect(await sessionOf({ openOn: { t1: { started, stock: listStock() } } })).toEqual({
      session_id: 's_started',
      status: 'ready',
      source: 'list',
      answered: 2,
      total: 10,
      started: true,
    });
    // Final review N1: started though nothing is answered yet, so the app resumes it.
    expect(await sessionOf({ openOn: { t1: { started: { ...started, answered: 0 } } } })).toMatchObject({ answered: 0, started: true });
    expect(await sessionOf({ openOn: { t1: { stock: listStock() } } })).toMatchObject({ session_id: 's_stock', started: false });
    expect(await sessionOf({ latestOn: { t1: failed } })).toMatchObject({ session_id: 's_failed', status: 'failed', started: false });
    expect(await sessionOf({ latestOn: { t1: done } })).toBeNull();
    expect(await sessionOf({})).toBeNull();
  });

  it('lists the active targets nearest date first, with today, and leaves out the ended, the past and another list’s', async () => {
    const { service } = world({
      saved: ['g_casa', 'g_gatto'],
      memory: memory('g_casa', ALL_SKILLS, solid),
      targets: [
        target({ id: 't_far', kind: 'homework', dueOn: '2026-11-01', words: ['g_casa', 'g_gatto'] }),
        target({ id: 't_near', dueOn: '2026-10-18', words: ['g_gatto'] }),
        target({ id: 't_ended', endedAt: new Date(NOW - 60_000) }),
        // Phase 57 (spec D10): active through its due date, and gone the day after.
        target({ id: 't_today', dueOn: TODAY }),
        target({ id: 't_past', dueOn: '2026-10-14' }),
        target({ id: 't_other', enrollmentId: 'e2' }),
      ],
    });

    expect(await service.list(OWNER, 'e1')).toEqual({
      today: TODAY,
      targets: [
        // A target on its due date is listed, due_today (phase 57, spec D10).
        expect.objectContaining({ id: 't_today', kind: 'exam', due_on: TODAY, days_left: 0, word_count: 1, ready_count: 0, today: expect.objectContaining({ state: 'due_today' }) }),
        expect.objectContaining({ id: 't_near', kind: 'exam', due_on: '2026-10-18', days_left: 3, word_count: 1 }),
        expect.objectContaining({ id: 't_far', kind: 'homework', due_on: '2026-11-01', days_left: 17, word_count: 2 }),
      ],
    });
  });

  it('shows each word in the form it was saved from, as the dictionary writes it, not lowercased (final review M3)', async () => {
    const { service } = world({ saved: ['g_roma', 'g_casa'], targets: [target({ words: ['g_roma', 'g_casa'] })] });
    expect((await service.getTarget(OWNER, 't1')).words.map((shown) => shown.form)).toEqual(['Roma', 'casa']);
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

// Phase 65 (spec D1, D4, D7, D9, D10). The summary's readiness is the expected grade on the date,
// from the target's readiness rows (else the main memory), counted on the skills the check asks
// that are live for the word; today is a budget of sessions.
describe('readiness and today’s budget on the summary (phase 65)', () => {
  const WRITE_SPELL: Dimension[] = ['written_productive', 'spelling'];
  const HOMEWORK: Dimension[] = ['written_productive', 'spelling', 'spoken_productive'];
  const budget = (sessions: number, cards: number): TargetBudget => ({ targetId: 't1', day: TODAY, sessions, cards, missRoom: 1, doneBefore: 0 });
  const dimensionsOf = (read: Awaited<ReturnType<TargetService['getTarget']>>, glossId: string) =>
    read.words.find((w) => w.gloss_id === glossId)!.skills.map((skill) => skill.dimension);

  it('counts a homework word that cannot be said on write and spell only, so it is not 0 (Review Focus 1)', async () => {
    const { service } = world({
      saved: ['g_lupo', 'g_casa'],
      targets: [target({ kind: 'homework', words: ['g_lupo', 'g_casa'] })],
      devices: { listening: true, speaking: true },
      readiness: [...readinessRows('g_lupo', WRITE_SPELL, solid), ...readinessRows('g_casa', WRITE_SPELL, solid)],
    });

    const read = await service.getTarget(OWNER, 't1');

    expect(dimensionsOf(read, 'g_lupo')).toEqual(WRITE_SPELL);
    expect(read.words.find((w) => w.gloss_id === 'g_lupo')?.readiness_pct).toBe(100);
    // casa can be said and this device records: its speaking counts, never answered, so 0.
    expect(dimensionsOf(read, 'g_casa')).toEqual(HOMEWORK);
    expect(read.words.find((w) => w.gloss_id === 'g_casa')?.readiness_pct).toBe(0);
    // lupo counted 100, the other word 0.
    expect(read.readiness_pct).toBe(50);
  });

  it('counts no word on speaking when the newest session did not record', async () => {
    const { service } = world({
      saved: ['g_casa'],
      targets: [target({ kind: 'homework', words: ['g_casa'] })],
      devices: { listening: true, speaking: false },
      readiness: readinessRows('g_casa', WRITE_SPELL, solid),
    });

    const read = await service.getTarget(OWNER, 't1');

    expect(dimensionsOf(read, 'g_casa')).toEqual(WRITE_SPELL);
    // 99, past the homework bar: counted 100 (phase 67b D2).
    expect(read.readiness_pct).toBe(100);
  });

  it('counts ready_count from 90 up, and shows an exam skill held at half', async () => {
    const { service } = world({
      saved: ['g_casa', 'g_gatto', 'g_cane'],
      targets: [target({ words: ['g_casa', 'g_gatto', 'g_cane'] })],
      readiness: [
        ...readinessRows('g_casa', WRITE_SPELL, solid),
        // 0.967 a skill: 0.935 the word, ready.
        ...readinessRows('g_gatto', WRITE_SPELL, { ...solid, stability: 20 }),
        // Written held at half after a cold miss: 0.5 × 0.999.
        ...readinessRows('g_cane', ['written_productive'], solid, { held: true }),
        ...readinessRows('g_cane', ['spelling'], solid),
      ],
    });

    const read = await service.getTarget(OWNER, 't1');

    // Phase 67b (spec D2): 99 and 96 are past the homework bar, each counted 100.
    expect(read.words.map((w) => w.readiness_pct)).toEqual([100, 100, 49]);
    // Phase 71 (spec D3). The same, on the summary the home list carries.
    expect(read.word_readiness).toEqual([100, 100, 49]);
    expect(read.ready_count).toBe(2);
    expect(read.words[2].skills).toEqual([
      { dimension: 'written_productive', chance: 49, held: true },
      { dimension: 'spelling', chance: 99, held: false },
    ]);
  });

  it("reads readiness at the start of today from each skill's first line today, its before", async () => {
    const { service } = world({
      saved: ['g_lupo'],
      targets: [target({ kind: 'homework', words: ['g_lupo'] })],
      readiness: readinessRows('g_lupo', WRITE_SPELL, solid, { day: TODAY }),
      firstEvents: {
        [`t1|${TODAY}`]: [
          { glossId: 'g_lupo', dimension: 'written_productive', before: 0.5 },
          { glossId: 'g_lupo', dimension: 'spelling', before: 0.5 },
        ],
        // Another day's lines are not today's.
        't1|2026-10-14': [{ glossId: 'g_lupo', dimension: 'spelling', before: 0 }],
      },
    });

    const read = await service.getTarget(OWNER, 't1');

    // Phase 67b (spec D1, D2): 99 now counts 100; at the start of today the weakest, 50.
    expect(read.readiness_pct).toBe(100);
    expect(read.readiness_start_pct).toBe(50);
  });

  it('says practice more cannot raise the card only when no word below its bar can move today (phase 67b D6)', async () => {
    /** The day after TODAY. */
    const EVE = '2026-10-16';
    const little = async (kind: 'exam' | 'homework', dueOn: string, state: MemoryState, over: Partial<ReadinessRow> = {}) =>
      (
        await world({
          saved: ['g_sole'],
          targets: [target({ kind, dueOn, words: ['g_sole'] })],
          // Met on an earlier day: practice more cannot meet it again.
          startedOn: { g_sole: '2026-10-14' },
          readiness: readinessRows('g_sole', WRITE_SPELL, state, over),
        }).service.getTarget(OWNER, 't1')
      ).practice_more_little;

    // Below its bar, its skills not yet answered today: another session raises the card.
    expect(await little('exam', DUE, fading)).toBe(false);
    // Answered today before the eve: only first answers count, so nothing more today.
    expect(await little('exam', DUE, fading, { day: TODAY })).toBe(true);
    // On the eve every right counts.
    expect(await little('exam', EVE, fading, { day: TODAY })).toBe(false);
    // At its bar the word already counts 100.
    expect(await little('homework', EVE, solid)).toBe(true);
    // A word not met yet: practice more can meet it while the day has room.
    const unmet = await world({
      saved: ['g_sole'],
      targets: [target({ kind: 'homework', words: ['g_sole'] })],
    }).service.getTarget(OWNER, 't1');
    expect(unmet.practice_more_little).toBe(false);
  });

  it('is owed before the budget is met and done once it is, a word still owed; the budget is the offer', async () => {
    const at = async (done: number) => {
      const { service, reads } = world({
        saved: ['g_casa'],
        targets: [target({ words: ['g_casa'] })],
        budgets: { [`t1|${TODAY}`]: budget(3, 13) },
        completed: { [`t1|${TODAY}`]: done },
      });
      return { read: await service.getTarget(OWNER, 't1'), reads };
    };

    const before = await at(2);
    expect(before.read.words[0].today).toBe('owed');
    expect(before.read.today).toMatchObject({
      state: 'owed',
      sessions_budget: 3,
      sessions_offer: 3,
      sessions_done: 2,
      ended_early: false,
      // 13 cards at about 30 seconds: 6.5, rounded.
      minutes: 7,
    });
    // A budget set is the one shown: nothing is played forward.
    expect(before.reads).not.toContain('findRecentAnswers');

    const met = await at(3);
    expect(met.read.words[0].today).toBe('owed');
    expect(met.read.today).toMatchObject({ state: 'done', sessions_budget: 3, sessions_done: 3, ended_early: false });
  });

  it('is owed on the eve with a word below its bar though the budget is met (phase 71, spec D1)', async () => {
    const { service } = world({
      saved: ['g_casa'],
      targets: [target({ dueOn: '2026-10-16', words: ['g_casa'] })],
      // Met before today, and its one practised skill asked today, missed: the plan owes nothing.
      startedOn: { g_casa: '2026-10-13' },
      answersOn: [{ glossId: 'g_casa', sessionId: 's1', targetId: 't1', type: 'typed_translation', correct: false }],
      budgets: { [`t1|${TODAY}`]: budget(3, 13) },
      completed: { [`t1|${TODAY}`]: 3 },
    });

    const read = await service.getTarget(OWNER, 't1');

    expect(read.days_left).toBe(1);
    expect(read.words[0].today).toBe('done');
    expect(read.readiness_pct).toBe(0);
    expect(read.today).toMatchObject({ state: 'owed', sessions_budget: 3, sessions_done: 3, ended_early: false });
  });

  it('ended early when no word is owed after 3 of 5', async () => {
    const { service } = world({
      saved: ['g_casa'],
      targets: [target({ words: ['g_casa'] })],
      // Started two days ago, ready (phase 67: it rests, no card owed), and the path practised today.
      startedOn: { g_casa: '2026-10-13' },
      readiness: readinessRows('g_casa', ALL_SKILLS, solid),
      answersOn: [{ glossId: 'g_casa', sessionId: 's1', targetId: 't1', type: 'multiple_choice', correct: true }],
      budgets: { [`t1|${TODAY}`]: budget(5, 20) },
      completed: { [`t1|${TODAY}`]: 3 },
    });

    const read = await service.getTarget(OWNER, 't1');

    expect(read.today).toMatchObject({ state: 'done', sessions_budget: 5, sessions_done: 3, ended_early: true });
  });

  it("offers the budget as it would be set now while none is set: before the day's first session, or after one started by its first answer", async () => {
    const { service, reads } = world({
      saved: ['g_casa'],
      targets: [target({ words: ['g_casa'] })],
      completed: { [`t1|${TODAY}`]: 1 },
    });

    const read = await service.getTarget(OWNER, 't1');

    // The picker played forward over the day (phase 67, spec D2, D5): casa, below 90, on a device
    // that cannot listen, owes its writing card, which asks spelling too: its ladder (4 cards). No
    // room for misses; and the one session done today. Four cards, at 30 s each: 2 minutes.
    expect(read.today).toMatchObject({
      state: 'owed',
      sessions_budget: null,
      sessions_offer: 1 + 1,
      sessions_done: 1,
      ended_early: false,
      minutes: 2,
    });
    expect(reads).not.toContain('findRecentAnswers');
  });

  // Final review I4. The home list's cost: the offer plays the picker forward only while the plan
  // owes work, and the reads that are the enrollment's are made once for the whole list.
  it('plays nothing forward on a day the plan owes nothing: the offer is the sessions done', async () => {
    const { service, reads } = world({
      saved: ['g_casa'],
      targets: [target({ words: ['g_casa'] })],
      // Started two days ago, ready (phase 67: it rests, no card owed), and the path practised today.
      startedOn: { g_casa: '2026-10-13' },
      readiness: readinessRows('g_casa', ALL_SKILLS, solid),
      answersOn: [{ glossId: 'g_casa', sessionId: 's1', targetId: 't1', type: 'multiple_choice', correct: true }],
      completed: { [`t1|${TODAY}`]: 1 },
    });

    const read = await service.getTarget(OWNER, 't1');

    // As the play would make it: no session to play, so the offer is the one done, no minutes.
    expect(read.today).toMatchObject({ state: 'done', sessions_budget: null, sessions_offer: 1, sessions_done: 1, ended_early: true, minutes: 0 });
    expect(reads).not.toContain('findRecentAnswers');
    expect(reads.filter((name) => name === 'countCompletedOn t1')).toHaveLength(1);
  });

  it("reads the enrollment's inputs to the offers once for the whole list, and each path's sessions done once", async () => {
    const { service, reads } = world({
      saved: ['g_casa', 'g_gatto'],
      targets: [target({ words: ['g_casa'] }), target({ id: 't2', dueOn: '2026-10-21', words: ['g_gatto'] })],
    });

    const listed = await service.list(OWNER, 'e1');

    // Both owe work and have no budget yet: each is offered its play.
    expect(listed.targets.map((one) => [one.id, one.today.state, one.today.sessions_budget])).toEqual([
      ['t1', 'owed', null],
      ['t2', 'owed', null],
    ]);
    expect(listed.targets.every((one) => one.today.sessions_offer > 0)).toBe(true);
    for (const once of ['listSavedGlosses', 'findAnswersOn', 'countCompletedOn t1', 'countCompletedOn t2']) {
      expect(reads.filter((name) => name === once)).toHaveLength(1);
    }
  });

  it('owes cards only for the words below 90 and offers exactly their sessions: homework at 2 days left (phase 67, spec D2, D5)', async () => {
    const { service } = world({
      saved: ['g_casa', 'g_gatto', 'g_cane'],
      targets: [target({ kind: 'homework', dueOn: '2026-10-17', words: ['g_casa', 'g_gatto', 'g_cane'] })],
      startedOn: { g_casa: '2026-10-13', g_gatto: '2026-10-13', g_cane: '2026-10-13' },
      // casa ready in all three skills; gatto only spells; cane has nothing yet.
      readiness: [...readinessRows('g_casa', ALL_SKILLS, solid), ...readinessRows('g_gatto', ['spelling'], fading)],
      devices: { listening: true, speaking: true },
    });

    const read = await service.getTarget(OWNER, 't1');

    expect(read.words.map((w) => [w.gloss_id, w.today, w.owed])).toEqual([
      ['g_casa', 'done', []],
      ['g_gatto', 'owed', ['written_productive', 'spoken_productive']],
      ['g_cane', 'owed', ['written_productive', 'spelling']],
    ]);
    // Four cards, two a word: one session, about 2 minutes.
    expect(read.today).toMatchObject({ state: 'owed', sessions_budget: null, sessions_offer: 1, minutes: 2 });
  });

  it("counts today's completed sessions of the target's path only (Review Focus 4: by practice_day)", async () => {
    const { service } = world({
      saved: ['g_casa'],
      targets: [target({ words: ['g_casa'] })],
      completed: { [`t1|${TODAY}`]: 2, 't1|2026-10-14': 4, [`null|${TODAY}`]: 5, [`t2|${TODAY}`]: 6 },
    });
    expect((await service.getTarget(OWNER, 't1')).today.sessions_done).toBe(2);
  });

  it('is due_today on its date whatever the budget, and never reads a memory moved on the date as certain (spec D3.7)', async () => {
    const { service } = world({
      saved: ['g_casa'],
      targets: [target({ dueOn: TODAY, words: ['g_casa'] })],
      readiness: readinessRows('g_casa', ['written_productive'], fading),
      // Spelling has no readiness row, and its main memory was reviewed today, on the date.
      memory: memory('g_casa', ['spelling'], solid),
      budgets: { [`t1|${TODAY}`]: budget(2, 8) },
      completed: { [`t1|${TODAY}`]: 2 },
    });

    const read = await service.getTarget(OWNER, 't1');

    expect(read.today).toMatchObject({ state: 'due_today', ended_early: false });
    expect(read.words[0].skills).toEqual([
      // As stored: stability 10, last moved 15 days before the date.
      { dimension: 'written_productive', chance: 86, held: false },
      { dimension: 'spelling', chance: 0, held: false },
    ]);
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

    expect(calls).toEqual([
      'lockNextSession main',
      'lockNextSession main',
      'lockNextSession t1',
      'lockEnrollment',
      'deleteEntry g_casa',
      'removeGlossFromTargets g_casa',
      'insertEvent words_removed',
      'enqueue e1',
      'enqueue e1:t1',
    ]);
    expect(events.map((event) => event.before)).toEqual([{ gloss_ids: ['g_casa'] }]);
  });

  it('writes no event for a word in no target, and keeps the stock: no target changed', async () => {
    const { vocabularyService, events, retired, jobs, logger } = world({ saved: ['g_gatto'], targets: [target()], open: { stock: listStock() } });
    await vocabularyService.unsave(OWNER, 'e1', 'g_gatto');
    expect(events).toEqual([]);
    expect(retired).toEqual([]);
    expect(jobs.enqueued).toEqual([]);
    expect(logged(logger, 'session_retired')).toEqual([]);
  });

  it('retires the unstarted list stock and asks for the next when the word left a target, as any change to one does (spec D12, final review M2)', async () => {
    const { vocabularyService, calls, retired, jobs, logger } = world({
      saved: ['g_casa', 'g_gatto'],
      targets: [target({ words: ['g_casa', 'g_gatto'] }), target({ id: 't2', words: ['g_casa'] })],
      open: { stock: listStock() },
    });

    await vocabularyService.unsave(OWNER, 'e1', 'g_casa');

    expect(retired).toEqual(['s_stock']);
    expect(jobs.enqueued).toEqual([MAIN_STOCK, targetStock('t1'), targetStock('t2')]);
    expect(logged(logger, 'session_retired')).toEqual([
      { event: 'session_retired', enrollment_id: 'e1', session_id: 's_stock', reason: 'target_changed' },
    ]);
    // The next-session locks before the entry is deleted, as every change to a target takes them:
    // the main path's, then its targets' (lockPaths); the stocks retired, then the progress lock,
    // then the next stocks asked for (ADR 0014 R4).
    expect(calls).toEqual([
      'lockNextSession main',
      'lockNextSession main',
      'lockNextSession t1',
      'lockNextSession t2',
      'retireStock',
      'lockEnrollment',
      'deleteEntry g_casa',
      'removeGlossFromTargets g_casa',
      'insertEvent words_removed',
      'insertEvent words_removed',
      'enqueue e1',
      'enqueue e1:t1',
      'enqueue e1:t2',
    ]);
  });
});

// Phase 58 meets phase 57 (ruling M1). Removing a level is an unsave of every word at it, by
// path: the main path's stock and the stock of each active target that held a removed word are
// retired before the progress lock and asked for again after it (ADR 0014 R4).
describe('vocabulary.removeWords (phase 58, ruling M1; 58b, ruling M2)', () => {
  const wordsRemoved = (job: { name: string; data: object; options: object }) => ({ ...job, data: { ...job.data, reason: 'words_removed' } });

  it('locks the main path and the active targets holding a removed word, retires their stocks, and asks for them after the progress lock', async () => {
    const { vocabularyService, calls, retired, jobs, logger, events, stored, saved } = world({
      saved: ['g_casa', 'g_gatto', 'g_cane'],
      atLevel: ['g_casa', 'g_gatto'],
      targets: [
        target({ words: ['g_casa', 'g_cane'] }),
        target({ id: 't2', words: ['g_cane'] }),
        // Ended: it loses the word, but has no path to restock.
        target({ id: 't3', words: ['g_gatto'], endedAt: new Date(NOW - 60_000) }),
      ],
      open: { stock: listStock() },
      openOn: { t1: { stock: listStock('s_t1') }, t2: { stock: listStock('s_t2') } },
    });

    expect(await vocabularyService.removeWords(OWNER, 'e1', { level: 1 })).toEqual({ removed_words: 2, removed_glosses: 2 });

    expect(saved).toEqual(['g_cane']);
    expect([...stored.values()].map((row) => [row.id, row.words])).toEqual([
      ['t1', ['g_cane']],
      ['t2', ['g_cane']],
      ['t3', []],
    ]);
    expect(events.map((event) => [event.targetId, event.kind, event.before, event.after])).toEqual([
      ['t1', 'words_removed', { gloss_ids: ['g_casa'] }, { reason: 'unsaved' }],
      ['t3', 'words_removed', { gloss_ids: ['g_gatto'] }, { reason: 'unsaved' }],
    ]);
    // t2 held no word at the level: its stock stays.
    expect(retired).toEqual(['s_stock', 's_t1']);
    expect(jobs.enqueued).toEqual([wordsRemoved(MAIN_STOCK), wordsRemoved(targetStock('t1'))]);
    expect(logged(logger, 'session_retired')).toEqual([
      { event: 'session_retired', enrollment_id: 'e1', session_id: 's_stock', reason: 'words_removed' },
      { event: 'session_retired', enrollment_id: 'e1', session_id: 's_t1', reason: 'words_removed' },
    ]);
    expect(calls).toEqual([
      'lockNextSession main',
      'lockNextSession main',
      'lockNextSession t1',
      'retireStock',
      'retireStock',
      'lockEnrollment',
      'deleteEntries g_casa g_gatto',
      'removeGlossesFromTargets g_casa g_gatto',
      'insertEvent words_removed',
      'insertEvent words_removed',
      'enqueue e1',
      'enqueue e1:t1',
    ]);
  });

  it("retires and asks for the main path's stock alone when no target held a removed word (final review I1)", async () => {
    const { vocabularyService, calls, retired, jobs, events } = world({
      saved: ['g_casa', 'g_gatto'],
      atLevel: ['g_gatto'],
      targets: [target()],
      open: { stock: listStock() },
      openOn: { t1: { stock: listStock('s_t1') } },
    });

    await vocabularyService.removeWords(OWNER, 'e1', { level: 1 });

    expect(events).toEqual([]);
    expect(retired).toEqual(['s_stock']);
    expect(jobs.enqueued).toEqual([wordsRemoved(MAIN_STOCK)]);
    expect(calls).toEqual([
      'lockNextSession main',
      'lockNextSession main',
      'retireStock',
      'lockEnrollment',
      'deleteEntries g_gatto',
      'removeGlossesFromTargets g_gatto',
      'enqueue e1',
    ]);
  });

  it('takes no lock past the main path and touches no stock when nothing is at the level', async () => {
    const { vocabularyService, calls, retired, jobs } = world({ saved: ['g_casa'], targets: [target()], open: { stock: listStock() } });

    expect(await vocabularyService.removeWords(OWNER, 'e1', { level: 3 })).toEqual({ removed_words: 0, removed_glosses: 0 });

    expect(calls).toEqual(['lockNextSession main']);
    expect(retired).toEqual([]);
    expect(jobs.enqueued).toEqual([]);
  });

  // Phase 58b (ruling M2). Every word is the same removal, whatever the level: each active
  // target holding a word goes by its path. One holding none can only be empty, which has no
  // stock (NoSavedWords): it is neither locked nor retired nor restocked.
  it('removes every saved word on all, by path in the same order', async () => {
    const { vocabularyService, calls, retired, jobs, events, stored, saved } = world({
      saved: ['g_casa', 'g_gatto', 'g_cane'],
      targets: [target({ words: ['g_casa'] }), target({ id: 't2', words: [] }), target({ id: 't3', words: ['g_cane', 'g_gatto'] })],
      open: { stock: listStock() },
      openOn: { t1: { stock: listStock('s_t1') }, t3: { stock: listStock('s_t3') } },
    });

    expect(await vocabularyService.removeWords(OWNER, 'e1', { all: true })).toEqual({ removed_words: 3, removed_glosses: 3 });

    expect(saved).toEqual([]);
    expect([...stored.values()].map((row) => [row.id, row.words])).toEqual([
      ['t1', []],
      ['t2', []],
      ['t3', []],
    ]);
    expect(events.map((event) => [event.targetId, event.before])).toEqual([
      ['t1', { gloss_ids: ['g_casa'] }],
      ['t3', { gloss_ids: ['g_cane', 'g_gatto'] }],
    ]);
    expect(retired).toEqual(['s_stock', 's_t1', 's_t3']);
    expect(jobs.enqueued).toEqual([wordsRemoved(MAIN_STOCK), wordsRemoved(targetStock('t1')), wordsRemoved(targetStock('t3'))]);
    expect(calls).toEqual([
      'lockNextSession main',
      'lockNextSession main',
      'lockNextSession t1',
      'lockNextSession t3',
      'retireStock',
      'retireStock',
      'retireStock',
      'lockEnrollment',
      'deleteEntries g_casa g_gatto g_cane',
      'removeGlossesFromTargets g_casa g_gatto g_cane',
      'insertEvent words_removed',
      'insertEvent words_removed',
      'enqueue e1',
      'enqueue e1:t1',
      'enqueue e1:t3',
    ]);
  });

  it('takes no lock past the main path and touches no stock when the list is empty', async () => {
    const { vocabularyService, calls, retired, jobs } = world({ saved: [], targets: [target({ words: [] })], open: { stock: listStock() } });

    expect(await vocabularyService.removeWords(OWNER, 'e1', { all: true })).toEqual({ removed_words: 0, removed_glosses: 0 });

    expect(calls).toEqual(['lockNextSession main']);
    expect(retired).toEqual([]);
    expect(jobs.enqueued).toEqual([]);
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
