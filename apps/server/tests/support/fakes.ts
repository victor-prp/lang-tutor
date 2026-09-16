import type { User } from '@lang-tutor/core/api';

import type { AppDeps } from '../../src/composition';
import {
  flattenEntries,
  rowsToSenses,
  type SenseRow,
  type StaleLexeme,
} from '../../src/domain/dictionary';
import type { StoredSense } from '../../src/domain/translation';
import { UsernameTaken } from '../../src/errors';
import type { Logger } from '../../src/logger';
import type { UserRepo } from '../../src/repo/users';
import type { CorrectionRow, PersistEntriesInput, DictRepo } from '../../src/repo/dictionary';
import type { LlmClient, LlmJsonRequest } from '../../src/services/llm';
import type { SessionService } from '../../src/services/sessions';
import type { Repos, Transaction } from '../../src/services/transaction';
import type { TranslationService } from '../../src/services/translations';
import type { UserService } from '../../src/services/users';

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
    startSession: unreachable,
    submitAnswer: unreachable,
  };
  const users: UserService = {
    register: unreachable,
    login: unreachable,
  };
  const translations: TranslationService = {
    translate: unreachable,
  };
  return {
    sessions,
    users,
    translations,
    health: { ping: unreachable },
    identity: { lane: 'test', database: 'test_db', port: 0 },
    logger: createFakeLogger(),
  };
}

/**
 * Replies in order; the last reply repeats once the queue is down to one, so a
 * test that calls twice does not have to say so. An Error in the queue is
 * thrown rather than returned, which is how a provider failure is simulated
 * without a socket.
 */
export function createFakeLlmClient(...replies: (string | Error)[]) {
  const calls: LlmJsonRequest[] = [];
  const queue = [...replies];

  const client: LlmClient = async (request) => {
    calls.push(request);
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next instanceof Error) throw next;
    return next;
  };

  return Object.assign(client, { calls });
}

// A repository a unit test can hold in its head: the same contract, backed by
// an array. It reproduces the one behaviour a caller depends on — a duplicate
// username raises UsernameTaken — because that is a contract of the interface,
// not an accident of Postgres.
export function createInMemoryUserRepo(): UserRepo & { rows: User[] } {
  const rows: User[] = [];
  let n = 0;
  return {
    rows,
    insertUser: async (input) => {
      if (rows.some((row) => row.username === input.username)) {
        throw new UsernameTaken(input.username);
      }
      const user: User = {
        id: `fake-user-${++n}`,
        username: input.username,
        display_name: input.display_name,
        age: input.age,
        native_language: input.native_language,
        target_language: input.target_language,
      };
      rows.push(user);
      return user;
    },
    findByUsername: async (username) => rows.find((row) => row.username === username),
    findById: async (id) => rows.find((row) => row.id === id),
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

/** Runs `run` immediately with whichever repositories the test named; every
 *  other one throws with the method that was reached for. No rollback, by
 *  design: a fake that pretended to roll back would be asserting a database
 *  behaviour it cannot actually provide. */
export function createFakeTransaction(repos: Partial<Repos>): Transaction {
  const bound: Repos = {
    user: repos.user ?? unreachableRepo('user repo'),
    session: repos.session ?? unreachableRepo('session repo'),
    question: repos.question ?? unreachableRepo('question repo'),
    dict: repos.dict ?? unreachableRepo('dict repo'),
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
   *  "this is a new lexeme, so no second model call". */
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
    repairVariantRenderings: async (input) => {
      repo.repaired.push({ variantId: input.variantId, senseVersion: input.senseVersion });
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
          created: true,
        })),
        senses: repo.reread.length > 0 ? rowsToSenses(repo.reread) : flattenEntries(input.entries),
      };
    },
  };
  return repo;
}
