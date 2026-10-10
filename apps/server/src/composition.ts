import type { PgBoss } from 'pg-boss';

import { createAuth, type AuthModule, type SendCode, type SessionReader } from './auth/betterAuth';
import type { AuthConfig, GeminiConfig } from './config';
import type { Db, Tx } from './db/client';
import { createTransaction } from './db/transaction';
import type { Logger } from './logger';
import { createGeminiClient, createGeminiTranscriber, createGeminiVisionClient } from './providers/gemini';
import { createResendMailer, RESEND_TIMEOUT_MS } from './providers/resend';
import { createAuthRepo } from './repo/auth';
import { createGlossRepo } from './repo/glosses';
import { createHealthRepo, type HealthRepo } from './repo/health';
import { createJobRepo, type JobRepo } from './repo/jobs';
import { createPhotoImportRepo } from './repo/photoImports';
import { createProgressRepo } from './repo/progress';
import { createQuestionRepo } from './repo/questions';
import { createSessionRepo } from './repo/sessions';
import { createEnrollmentRepo } from './repo/enrollments';
import { createGrantRepo } from './repo/grants';
import { createUserRepo } from './repo/users';
import { createDictRepo } from './repo/dictionary';
import { createVocabularyRepo } from './repo/vocabulary';
import { createEnrollmentService, type EnrollmentService } from './services/enrollments';
import { createGlossService, type GlossService } from './services/glosses';
import type { LlmClient, VisionClient } from './services/llm';
import { createPhotoImportService, type PhotoImportService } from './services/photoImports';
import { createSessionService, type SessionService } from './services/sessions';
import type { SpeechTranscriber } from './services/speech';
import type { Repos } from './services/transaction';
import { createTranslationService, type TranslationService } from './services/translations';
import { createUserService, type UserService } from './services/users';
import { createGrantService, type GrantService } from './services/grants';
import { createVocabularyService, type VocabularyService } from './services/vocabulary';

/**
 * Which checkout this process belongs to, as published by /health. Data, not a
 * collaborator: app.ts holds no logic, so the values arrive already resolved
 * from the composition root that read the environment.
 */
export type ServerIdentity = {
  lane: string;
  database: string;
  port: number;
  // Phase 30. The release tag; `dev` outside the image.
  version: string;
};

export type AppDeps = {
  sessions: SessionService;
  users: UserService;
  enrollments: EnrollmentService;
  translations: TranslationService;
  vocabulary: VocabularyService;
  grants: GrantService;
  photoImports: PhotoImportService;
  // Phase 31 (spec D7). The merge job's use case; no route reaches it. The
  // tool's plan and apply come with the type, unused here and composed with a
  // null model: db/cli.ts builds its own through createGlossTools.
  glosses: GlossService;
  health: HealthRepo;
  identity: ServerIdentity;
  // Phase 30 (spec D1). Set only inside the image; app.ts serves the export from it.
  webDistDir: string | null;
  logger: Logger;
  // Phase 29. The four mounted Better Auth paths and their handler (spec D3).
  auth: {
    handler: AuthModule['handler'];
    paths: readonly { method: 'GET' | 'POST'; path: string }[];
  };
  // Phase 29. Reads the session behind a request (spec D11). Only routes/actor.ts uses it.
  signedIn: SessionReader;
  // Phase 29 (spec D15). The browser origins CORS admits, with credentials.
  webOrigins: string[];
};

// A tool that enqueues nothing gets a jobs repository that says so.
const NO_JOBS: JobRepo = {
  enqueue: async () => {
    throw new Error('this composition enqueues no job');
  },
};

/** Every repository bound to one transaction: what a use case receives (R8). */
function bindRepos(tx: Tx, boss: PgBoss | null): Repos {
  return {
    session: createSessionRepo(tx),
    question: createQuestionRepo(tx),
    user: createUserRepo(tx),
    enrollment: createEnrollmentRepo(tx),
    grant: createGrantRepo(tx),
    dict: createDictRepo(tx),
    vocabulary: createVocabularyRepo(tx),
    progress: createProgressRepo(tx),
    jobs: boss ? createJobRepo(tx, boss) : NO_JOBS,
    photoImport: createPhotoImportRepo(tx),
    gloss: createGlossRepo(tx),
  };
}

// Assembly only: no I/O, no logic, no conditionals beyond choosing an
// implementation. `db` and `logger` are received rather than built here because
// createDb opens a real pool — that stays in main(), and everything above it is
// a pure function a test can call.
export function createServerDeps(io: {
  db: Db;
  logger: Logger;
  rng: () => number;
  // Phase 24. A clock, received as rng is: it times the generation call.
  now: () => number;
  fetch: typeof globalThis.fetch;
  gemini: GeminiConfig;
  // Phase 29. Better Auth's secret and origins, and Resend's key.
  auth: AuthConfig;
  // The provider's whole budget for one call. No retry: a learner who taps
  // retry *is* the retry. Received rather than a module constant so a test can
  // inject a short budget instead of paying a slow provider's delay in
  // wall-clock time — see config.ts's TRANSLATION_TIMEOUT_MS default.
  translationTimeoutMs: number;
  // Phase 19. The budget of one distractor call: a session's whole batch is one
  // long answer, so it gets its own, longer than a lookup's.
  sessionGenerationTimeoutMs: number;
  // Phase 25 (spec D13). One transcription's budget: short, because a learner
  // is waiting on a card.
  speechTimeoutMs: number;
  // Phase 26 (spec D5). One photo read's budget: a long call over an image,
  // longer than a lookup's.
  photoReadTimeoutMs: number;
  // Phase 27 (spec D4). One judged answer's budget: a learner is waiting on it.
  judgeTimeoutMs: number;
  identity: ServerIdentity;
  webDistDir: string | null;
  // Phase 19. Constructed and started in main() — starting it is I/O, and
  // composition performs none (ADR 0001 R6). Only the jobs repository uses it.
  boss: PgBoss;
}): AppDeps {
  // Binding the repositories to a transaction is assembly, which is what this
  // file is for. Doing it here is what lets services/ take a transaction rather
  // than a database.
  const transaction = createTransaction(io.db, (tx) => bindRepos(tx, io.boss));

  // The one place in the repo that names both `createGeminiClient` and
  // `LlmClient` (ADR 0001 R11). The annotation below is what checks that the
  // provider satisfies the contract — providers/ cannot import it, exactly as
  // db/transaction.ts cannot import Transaction.
  const llm: LlmClient = createGeminiClient({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    timeoutMs: io.translationTimeoutMs,
  });

  // Phase 19. The same provider with its own budget: a session's distractors
  // are one long answer, and a lookup's 25 s would cut it off.
  const sessionLlm: LlmClient = createGeminiClient({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    timeoutMs: io.sessionGenerationTimeoutMs,
  });

  // Phase 25. The same provider over audio. Named here and nowhere else
  // (ADR 0001 R11); the annotation checks it satisfies the contract.
  const transcriber: SpeechTranscriber = createGeminiTranscriber({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    timeoutMs: io.speechTimeoutMs,
  });

  // Phase 26 (spec D5). The same provider reading a photo, with a read's budget.
  // The annotation is what checks it satisfies the contract (ADR 0001 R11).
  const vision: VisionClient = createGeminiVisionClient({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    timeoutMs: io.photoReadTimeoutMs,
  });

  // Phase 27 (spec D3). The judge waits on the learner, as the transcriber
  // does: its own budget, and thinking off for the wait (D4).
  const judge: LlmClient = createGeminiClient({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    timeoutMs: io.judgeTimeoutMs,
    thinkingBudget: 0,
  });

  // Phase 29 (spec D16). The one place that names both the Resend provider and
  // the SendCode contract it satisfies (ADR 0001 R11).
  const mailer = createResendMailer({
    fetch: io.fetch,
    baseUrl: io.auth.resendBaseUrl,
    apiKey: io.auth.resendApiKey,
    from: io.auth.mailFrom,
    timeoutMs: RESEND_TIMEOUT_MS,
  });
  const sendCode: SendCode = mailer.sendSignInCode;
  const authModule = createAuth({
    db: io.db,
    authRepo: createAuthRepo(io.db),
    secret: io.auth.secret,
    baseUrl: io.auth.baseUrl,
    webOrigins: io.auth.webOrigins,
    sendCode,
    now: io.now,
    logger: io.logger,
  });

  const translations = createTranslationService({ llm, transaction, logger: io.logger });

  return {
    sessions: createSessionService({
      transaction,
      rng: io.rng,
      now: io.now,
      logger: io.logger,
      llm: sessionLlm,
      transcriber,
      judge,
    }),
    users: createUserService({ transaction, logger: io.logger }),
    enrollments: createEnrollmentService({ transaction, logger: io.logger }),
    translations,
    vocabulary: createVocabularyService({ transaction, logger: io.logger }),
    grants: createGrantService({ transaction, logger: io.logger }),
    // Phase 26. Handed the lookup use case itself, so a row is looked up exactly
    // as a typed word is (spec D7). The match call shares the lookup's client
    // and budget.
    photoImports: createPhotoImportService({
      transaction,
      vision,
      llm,
      lookup: translations.translate,
      now: io.now,
      logger: io.logger,
    }),
    // No model composed here: the tool's tier 2 is built by createGlossTools.
    glosses: createGlossService({ transaction, logger: io.logger, llm: null }),
    health: createHealthRepo(io.db, io.logger),
    identity: io.identity,
    webDistDir: io.webDistDir,
    logger: io.logger,
    auth: { handler: authModule.handler, paths: authModule.paths },
    signedIn: { sessionOf: authModule.sessionOf },
    webOrigins: io.auth.webOrigins,
  };
}

/**
 * Phase 31 (spec D7). The by-hand merge tool's use cases, for db/cli.ts: the
 * glosses service with a transaction and, for tier 2, a model client, and
 * nothing else a server needs. No I/O here (R6): the caller owns the pool.
 * `gemini` null composes no client: tier 1 alone, which needs no Gemini settings.
 */
export function createGlossTools(io: {
  db: Db;
  logger: Logger;
  fetch: typeof globalThis.fetch;
  gemini: GeminiConfig | null;
  timeoutMs: number;
}): GlossService {
  const transaction = createTransaction(io.db, (tx) => bindRepos(tx, null));
  const llm: LlmClient | null = io.gemini
    ? createGeminiClient({
        fetch: io.fetch,
        baseUrl: io.gemini.baseUrl,
        apiKey: io.gemini.apiKey,
        model: io.gemini.model,
        timeoutMs: io.timeoutMs,
      })
    : null;
  return createGlossService({ transaction, logger: io.logger, llm });
}
