import type { User } from '@lang-tutor/core/api';

import type { AppDeps } from '../../src/composition';
import {
  flattenEntries,
  rowsToCards,
  type SenseRow,
  type StaleLexeme,
} from '../../src/domain/dictionary';
import type { StoredSense } from '../../src/domain/translation';
import { ProfileExists, UsernameTaken } from '../../src/errors';
import type { Logger } from '../../src/logger';
import type { UserRepo } from '../../src/repo/users';
import type { JobRepo } from '../../src/repo/jobs';
import type { PronunciationRepo } from '../../src/repo/pronunciationScores';
import type { TargetRepo } from '../../src/repo/targets';
import type { CorrectionRow, PersistEntriesInput, DictRepo, GlossCounts, MergePair } from '../../src/repo/dictionary';
import type { EnrollmentService } from '../../src/services/enrollments';
import type { PhotoImportService } from '../../src/services/photoImports';
import type { ReminderService } from '../../src/services/reminders';
import type { LlmClient, LlmJsonRequest } from '../../src/services/llm';
import type { LlmAudioRequest, SpeechTranscriber } from '../../src/services/speech';
import type { SessionService } from '../../src/services/sessions';
import type { TargetService } from '../../src/services/targets';
import type { Repos, Transaction } from '../../src/services/transaction';
import type { TranslationService } from '../../src/services/translations';
import type { GrantService } from '../../src/services/grants';
import type { VocabularyService } from '../../src/services/vocabulary';
import type { UserService } from '../../src/services/users';
import type { BotService } from '../../src/services/bots';
import { passRequestsThrough } from '../../src/routes/requestLog';

export type FakeLogger = Logger & {
  events: Record<string, unknown>[];
  errors: { message: string; cause?: unknown }[];
};

// A capturing Logger: a fake passed in, rather than a spy patched onto
// process-global `console` and mutated inside a Jest worker.
export function createFakeLogger(): FakeLogger {
  const events: Record<string, unknown>[] = [];
  const errors: { message: string; cause?: unknown }[] = [];
  return {
    events,
    errors,
    info: (event) => {
      events.push(event);
    },
    error: (message, cause) => {
      errors.push({ message, cause });
    },
  };
}

// For tests that assert something about the *shape* of the app rather than its
// behaviour — the published document, for one. Every collaborator throws,
// because a document is generated from route definitions and must never reach a
// handler; if one of these fires, the test is asserting the wrong thing.
export function createFakeAppDeps(): AppDeps {
  const unreachable = (): never => {
    throw new Error('a document-shape test must not reach a collaborator');
  };
  const sessions: SessionService = {
    createNextSession: unreachable,
    getSession: unreachable,
    currentSession: unreachable,
    skipSession: unreachable,
    submitAnswer: unreachable,
    answerBySpeech: unreachable,
    answerJudged: unreachable,
    answerText: unreachable,
    prepareSession: unreachable,
    failPreparation: unreachable,
    startSession: unreachable,
    stockSession: unreachable,
  };
  const users: UserService = {
    createProfile: unreachable,
    me: unreachable,
    setTimeZone: unreachable,
    hasProfile: unreachable,
  };
  const enrollments: EnrollmentService = { enroll: unreachable, list: unreachable };
  const translations: TranslationService = {
    translate: unreachable,
    renderLemma: unreachable,
    failLemmaRender: unreachable,
    acceptRendering: unreachable,
    failAcceptRendering: unreachable,
  };
  const vocabulary: VocabularyService = {
    save: unreachable,
    unsave: unreachable,
    removeWords: unreachable,
    listWords: unreachable,
    wordDetail: unreachable,
  };
  const grants: GrantService = { invite: unreachable, list: unreachable, accept: unreachable, end: unreachable };
  const reminders: ReminderService = {
    settings: unreachable,
    putSettings: unreachable,
    registerDevice: unreachable,
    unregisterDevice: unreachable,
    tap: unreachable,
    requestTick: unreachable,
    tick: unreachable,
  };
  const photoImports: PhotoImportService = {
    create: unreachable,
    list: unreachable,
    getImport: unreachable,
    updateItem: unreachable,
    save: unreachable,
    discard: unreachable,
    readPhoto: unreachable,
    failRead: unreachable,
    lookUpItem: unreachable,
    failItem: unreachable,
  };
  const targets: TargetService = {
    list: unreachable,
    getTarget: unreachable,
    create: unreachable,
    addWords: unreachable,
    removeWord: unreachable,
    changeDate: unreachable,
    end: unreachable,
  };
  return {
    sessions,
    users,
    enrollments,
    translations,
    vocabulary,
    grants,
    reminders,
    photoImports,
    targets,
    glosses: { mergeLexeme: unreachable, planMerges: unreachable, applyMerges: unreachable },
    health: { ping: unreachable },
    identity: { lane: 'test', database: 'test_db', port: 0, version: 'test', commit: 'test' },
    webDistDir: null,
    logger: createFakeLogger(),
    // A pass-through: a shape test logs no requests.
    requestLog: passRequestsThrough,
    auth: { handler: async () => new Response(null, { status: 500 }), paths: [] },
    signedIn: { sessionOf: async () => null },
    webOrigins: ['https://web.example.test'],
    bots: null,
    reminderTick: null,
  };
}

/** Phase 35. The bot route's deps for a document-shape test: mounted, unreachable. */
export function createFakeBots(): NonNullable<AppDeps['bots']> {
  const unreachable = (): never => {
    throw new Error('a document-shape test must not reach a collaborator');
  };
  const service: BotService = { signIn: unreachable, setDay: unreachable };
  return { secret: 'x'.repeat(32), service };
}

/** Phase 52. The reminder tick's deps for a document-shape test: mounted, unreachable. */
export function createFakeReminderTick(): NonNullable<AppDeps['reminderTick']> {
  return { secret: 'y'.repeat(32), service: createFakeAppDeps().reminders };
}

/**
 * Replies in order; the last reply repeats once the queue is down to one, so a
 * test that calls twice does not have to say so. An Error in the queue is
 * thrown rather than returned, which is how a provider failure is simulated
 * without a socket. Phase 34: a function in the queue answers from the request,
 * for a call whose answer must name what it was asked (the checker's).
 */
export function createFakeLlmClient(...replies: (string | Error | ((request: LlmJsonRequest) => string))[]) {
  const calls: LlmJsonRequest[] = [];
  const queue = [...replies];

  const client: LlmClient = async (request) => {
    calls.push(request);
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(request) : next;
  };

  return Object.assign(client, { calls });
}

/** Phase 25. Replies in order, the last repeating, as createFakeLlmClient does.
 *  An Error in the queue is thrown. */
export function createFakeTranscriber(...replies: (string | Error)[]) {
  const calls: LlmAudioRequest[] = [];
  const queue = [...replies];
  const transcriber: SpeechTranscriber = async (request) => {
    calls.push(request);
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next instanceof Error) throw next;
    return next;
  };
  return Object.assign(transcriber, { calls });
}

/** Phase 50 (spec D3). Stored pronunciation scores in memory: `rows` is what
 *  a test seeds and reads back, and the first score of a pair stands. */
export function createFakePronunciationRepo(rows: { language: string; a: string; b: string; score: number }[] = []) {
  const same = (language: string, pair: { a: string; b: string }) => (row: (typeof rows)[number]) =>
    row.language === language && row.a === pair.a && row.b === pair.b;
  const repo: PronunciationRepo = {
    find: async (language, pairs) =>
      rows.filter((row) => pairs.some((pair) => same(language, pair)(row))).map(({ a, b, score }) => ({ a, b, score })),
    insert: async (language, inserted) => {
      for (const row of inserted) if (!rows.some(same(language, row))) rows.push({ language, ...row });
    },
  };
  return Object.assign(repo, { rows });
}

/** Phase 31. resolveGlosses as the identity, in one learner language: no merge
 *  happened. Records every id it was asked about. */
export function createFakeGlossRepo(userLanguageCode = 'he') {
  const asked: string[][] = [];
  return {
    asked,
    resolveGlosses: async (ids: string[]) => {
      asked.push(ids);
      return new Map(ids.map((id) => [id, { id, lexemeId: `lexeme-of-${id}`, userLanguageCode }]));
    },
    findMergeCandidates: async () => [],
    mergeGlosses: async () => null,
    findMergeWork: async () => [],
    setDefinitions: async () => 0,
  };
}

export type FakeJobRepo = JobRepo & {
  enqueued: { name: string; data: unknown; options?: { singletonKey?: string; startAfterSeconds?: number } }[];
};

/** Records what a use case enqueued. No queue behind it: a unit test asserts
 *  the call, the integration suite asserts the job row. Options are recorded
 *  only when given (phase 34). */
export function createFakeJobRepo(): FakeJobRepo {
  const enqueued: FakeJobRepo['enqueued'] = [];
  return {
    enqueued,
    enqueue: async (name, data, options) => {
      enqueued.push({ name, data, ...(options ? { options } : {}) });
    },
    // Phase 43. Recorded as a send: what it postpones is pg-boss's to prove.
    enqueueOrPostpone: async (name, data, options) => {
      enqueued.push({ name, data, options });
    },
  };
}

export type FakeTargetRepo = TargetRepo & {
  /** Every write the repo was handed, in order, with its arguments. */
  written: { method: string; args: unknown[] }[];
};

/**
 * Phase 53. A target repository for a learner with no target: the reads a session
 * makes find nothing (no active target, no recorded split, no target ended on its
 * date), and the writes are recorded no-ops that report nothing happened. Every other
 * method throws with its name, so a test that reaches a target it never set up fails
 * there. insertTarget is one of those: its caller needs the row it makes, which a
 * no-op cannot invent, so a test that creates a target says what comes back.
 * `overrides` replaces any method; the rest keep their defaults.
 */
export function createFakeTargetRepo(overrides: Partial<TargetRepo> = {}): FakeTargetRepo {
  const written: FakeTargetRepo['written'] = [];
  const missing = unreachableRepo<TargetRepo>('target repo');
  return {
    written,
    insertTarget: missing.insertTarget,
    findTarget: missing.findTarget,
    findTargetForUpdate: missing.findTargetForUpdate,
    listActive: async () => [],
    listWordIds: missing.listWordIds,
    addWords: async (...args) => {
      written.push({ method: 'addWords', args });
      return [];
    },
    removeWord: async (...args) => {
      written.push({ method: 'removeWord', args });
      return false;
    },
    removeGlossFromTargets: async (...args) => {
      written.push({ method: 'removeGlossFromTargets', args });
      return [];
    },
    removeGlossesFromTargets: async (...args) => {
      written.push({ method: 'removeGlossesFromTargets', args });
      return new Map();
    },
    setDueOn: async (...args) => {
      written.push({ method: 'setDueOn', args });
    },
    end: async (...args) => {
      written.push({ method: 'end', args });
      return false;
    },
    listEndedUnrecorded: async () => [],
    insertEvent: async (...args) => {
      written.push({ method: 'insertEvent', args });
    },
    insertSessionSplit: async (...args) => {
      written.push({ method: 'insertSessionSplit', args });
    },
    findSessionSplit: async () => [],
    ...overrides,
  };
}

// A repository a unit test can hold in its head: the same contract, backed by
// an array. It reproduces the two behaviours a caller depends on — a second
// profile for one id raises ProfileExists, a duplicate username raises
// UsernameTaken — because those are contracts of the interface, not accidents
// of Postgres.
export function createInMemoryUserRepo(): UserRepo & { rows: User[] } {
  const rows: User[] = [];
  const zoneOf = (userId: string) => rows.find((row) => row.id === userId)?.time_zone;
  return {
    rows,
    insertUser: async (id, input) => {
      if (rows.some((row) => row.id === id)) throw new ProfileExists(id);
      if (rows.some((row) => row.username === input.username)) {
        throw new UsernameTaken(input.username);
      }
      const user: User = {
        id,
        username: input.username,
        display_name: input.display_name,
        age: input.age,
        native_language: input.native_language,
        time_zone: 'UTC', // the column's default, until the app reports one
      };
      rows.push(user);
      return user;
    },
    findDayContext: async (userId) => {
      const timeZone = zoneOf(userId);
      return timeZone === undefined ? undefined : { kind: 'learner', timeZone };
    },
    setTimeZone: async (userId, timeZone) => {
      const at = rows.findIndex((row) => row.id === userId);
      if (at !== -1) rows[at] = { ...rows[at], time_zone: timeZone };
    },
    findTimeZone: async (userId) => zoneOf(userId),
    findByUsername: async (username) => rows.find((row) => row.username === username),
    findById: async (id) => rows.find((row) => row.id === id),
    // Phase 35. Every row here is a learner, so no name names a bot.
    insertBot: async () => {
      throw new Error('the in-memory user repo holds learners only');
    },
    findBotByName: async () => undefined,
    setBotDay: async () => false,
  };
}

// A Proxy rather than a hand-listed stub: a test that reaches one of these
// should fail with the method name it reached for, and adding a repository
// method must not mean editing this file.
function unreachableRepo<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get: (_target, property) => () => {
      throw new Error(`${name}.${String(property)} must not be called by this test`);
    },
  });
}

// Only the methods a case names exist; any other reach fails with its name.
export function stub<T extends object>(methods: Partial<T>): T {
  return new Proxy(methods, {
    get: (target, property) =>
      (target as Record<string | symbol, unknown>)[property] ??
      (() => {
        throw new Error(`${String(property)} is not stubbed`);
      }),
  }) as T;
}

/** Runs `run` immediately with whichever repositories the test named; every
 *  other one throws with the method that was reached for, bar `target` (phase
 *  53), which stands for a learner with no target: see createFakeTargetRepo.
 *  No rollback, by design: a fake that pretended to roll back would be
 *  asserting a database behaviour it cannot actually provide. */
export function createFakeTransaction(repos: Partial<Repos>): Transaction {
  const bound: Repos = {
    user: repos.user ?? unreachableRepo('user repo'),
    enrollment: repos.enrollment ?? unreachableRepo('enrollment repo'),
    grant: repos.grant ?? unreachableRepo('grant repo'),
    session: repos.session ?? unreachableRepo('session repo'),
    question: repos.question ?? unreachableRepo('question repo'),
    dict: repos.dict ?? unreachableRepo('dict repo'),
    gloss: repos.gloss ?? unreachableRepo('gloss repo'),
    vocabulary: repos.vocabulary ?? unreachableRepo('vocabulary repo'),
    progress: repos.progress ?? unreachableRepo('progress repo'),
    memory: repos.memory ?? unreachableRepo('memory repo'),
    glossFamilies: repos.glossFamilies ?? unreachableRepo('gloss families repo'),
    jobs: repos.jobs ?? unreachableRepo('jobs repo'),
    photoImport: repos.photoImport ?? unreachableRepo('photo import repo'),
    modelCall: repos.modelCall ?? unreachableRepo('model call repo'),
    pronunciation: repos.pronunciation ?? unreachableRepo('pronunciation repo'),
    reminders: repos.reminders ?? unreachableRepo('reminders repo'),
    target: repos.target ?? createFakeTargetRepo(),
  };
  return (run) => run(bound);
}

export type FakeDictRepo = DictRepo & {
  /**
   * What the by-form read answers with, KEYED BY FORM and matched
   * case-insensitively, the way the real index is. An absent key is a miss.
   *
   * A record rather than a single array since phase 13: steps 1, 3 and 5b of the
   * lookup call `findSensesByForm` with different forms in ONE lookup and must
   * get different answers. Before phase 13 every lookup read one form, and a
   * single array was exactly right.
   */
  hit: Record<string, SenseRow[]>;
  /** What `findSensesByLexeme` answers with, keyed `lemma:partOfSpeech`. A
   *  lexeme absent from this map has no stored senses, which is how a test says
   *  "this is a new lexeme, so no second model call". Not keyed by the learner's
   *  language: since phase 31 the real read lists a sense rendered in any
   *  language, and `glossLanguage` on an entry says which (spec D9). */
  stored: Record<string, StoredSense[]>;
  lexemeReads: { lemma: string; partOfSpeech: string }[];
  /** What the write's re-read answers with. Left empty, the fake answers with
   *  the entries it was handed, flattened by the real domain function — which
   *  is what the real re-read would produce for a form nobody else claims. */
  reread: SenseRow[];
  /** What `findStaleLexemesByForm` answers with, keyed by form. An absent key is
   *  level — the default, so a test that never mentions staleness keeps taking the
   *  plain-hit branch. */
  stale: Record<string, StaleLexeme[]>;
  /** The redirect table, keyed by TYPED form, matched case-insensitively. */
  corrections: Record<string, CorrectionRow>;
  /** Every `persistCorrection` call, in order. */
  correctionsWritten: {
    typedForm: string;
    correctedForm: string;
    alternatives: string[];
    languageCode: string;
  }[];
  /** Every `repairVariantRenderings` call, in order — no longer unreachable from
   *  phase 13 on, because the redirect-and-repair tests drive it. */
  repaired: { variantId: string; senseVersion: number }[];
  /** Set to make the write throw. */
  persistError: Error | null;
  persisted: PersistEntriesInput[];
  /** Phase 31. What the write reports as needing D7's merge job. */
  mergePairs: MergePair[];
  /** Phase 31. What the write reports its gloss step did (spec D19). */
  glossCounts: GlossCounts;
  reads: { form: string; languageCode: string; userLanguageCode: string }[];
};

export function createFakeDictRepo(): FakeDictRepo {
  // One lookup rule for all three maps, matching the real index's
  // (language_code, lower(form)) exactly — so a test that writes `Thruot` and
  // reads `thruot` behaves the way Postgres does.
  const at = <T>(map: Record<string, T>, form: string): T | undefined =>
    map[form] ?? map[Object.keys(map).find((key) => key.toLowerCase() === form.toLowerCase()) ?? ''];

  const repo: FakeDictRepo = {
    hit: {},
    stored: {},
    lexemeReads: [],
    reread: [],
    stale: {},
    corrections: {},
    correctionsWritten: [],
    repaired: [],
    persistError: null,
    persisted: [],
    mergePairs: [],
    glossCounts: { created: 0, joined: 0, members: 0 },
    reads: [],
    findSensesByForm: async (input) => {
      repo.reads.push(input);
      return at(repo.hit, input.form) ?? [];
    },
    findSensesByLexeme: async (input) => {
      repo.lexemeReads.push({ lemma: input.lemma, partOfSpeech: input.partOfSpeech });
      const senses = repo.stored[`${input.lemma}:${input.partOfSpeech}`] ?? [];
      // A test builds `stored` entries without a senseId — the repository's own
      // shape is what changed, not what a unit test needs to say. Synthesized
      // from the sense_code, which is unique per lexeme, same as the real id.
      return senses.map((sense) => ({ senseId: `sense-${sense.senseCode}`, ...sense }));
    },
    findStaleLexemesByForm: async (input) => at(repo.stale, input.form) ?? [],
    findCorrectionByForm: async (input) => at(repo.corrections, input.form),
    persistCorrection: async (input) => {
      repo.correctionsWritten.push(input);
      // First-writer-wins, like the real one: a second write for one typed form
      // is a no-op that leaves the first target in place.
      const existing = at(repo.corrections, input.typedForm);
      if (!existing) {
        repo.corrections[input.typedForm] = {
          typedForm: input.typedForm,
          correctedForm: input.correctedForm,
          alternatives: input.alternatives,
        };
      }
    },
    findSenseVersion: async () => 0,
    lockLexemes: async () => {},
    // Phase 31 (spec D12). The render-lemma job's reads and the saves' claims;
    // a lookup reaches none of them.
    findLexeme: async () => undefined,
    findLexemeForms: async () => [],
    hasLemmaRendering: async () => false,
    nextEntryRank: async () => 0,
    claimLemmaRenders: async () => [],
    claimSavedLemmaRenders: async () => [],
    releaseLemmaRender: async () => false,
    // Phase 34 (spec D1, D13). The accept job's read and write, and the
    // backfill's; a lookup reaches none of them.
    findRenderingForAccept: async () => undefined,
    storeAccepted: async () => false,
    findUnacceptedSavedRenderings: async () => [],
    // Phase 31 (spec D12, D18). A session's reads; a lookup reaches neither.
    findGlossRenderings: async () => [],
    findSiblings: async () => [],
    findKnownRight: async () => ({ meaningsByLexeme: new Map(), meaningsByGloss: new Map(), wordsByPrompt: new Map() }),
    repairVariantRenderings: async (input) => {
      repo.repaired.push({ variantId: input.variantId, senseVersion: input.senseVersion });
      return { needsMerge: false };
    },
    persistEntries: async (input) => {
      repo.persisted.push(input);
      if (repo.persistError) throw repo.persistError;
      return {
        written: input.entries.map((entry, index) => ({
          lemma: entry.lemma,
          lexemeId: `t-${index}`,
          variantId: `v-${index}`,
          senseIds: entry.senses.map((_, rank) => `s-${index}-${rank}`),
          glossIds: entry.senses.map((_, rank) => `g-${index}-${rank}`),
          created: true,
        })),
        senses: repo.reread.length > 0 ? rowsToCards(repo.reread) : flattenEntries(input.entries, input.kind),
        mergePairs: repo.mergePairs,
        glosses: repo.glossCounts,
      };
    },
  };
  return repo;
}

/** Phase 24. A clock that returns `ticks` in turn, then stays on the last. */
export function createFakeClock(...ticks: number[]): () => number {
  const queue = [...ticks];
  return () => (queue.length > 1 ? queue.shift()! : queue[0]);
}
