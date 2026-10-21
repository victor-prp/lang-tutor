import type { MiddlewareHandler } from 'hono';
import type { PgBoss } from 'pg-boss';

import { createAuth, type AuthModule, type SendCode, type SessionReader } from './auth/betterAuth';
import type { AuthConfig, GeminiConfig } from './config';
import type { Db, Tx } from './db/client';
import { createTransaction } from './db/transaction';
import type { Logger } from './logger';
import { createExpoPushClient, PUSH_TIMEOUT_MS } from './providers/expoPush';
import { createGeminiClient, createGeminiTranscriber, createGeminiVisionClient } from './providers/gemini';
import { createResendMailer, RESEND_TIMEOUT_MS } from './providers/resend';
import { createAuthRepo } from './repo/auth';
import { createRequestLog, passRequestsThrough } from './routes/requestLog';
import { createGlossFamiliesRepo } from './repo/glossFamilies';
import { createGlossRepo } from './repo/glosses';
import { createHealthRepo, type HealthRepo } from './repo/health';
import { createMemoryRepo } from './repo/memory';
import { createJobRepo, type JobRepo } from './repo/jobs';
import { createPhotoImportRepo } from './repo/photoImports';
import { createDiscoveryRepo } from './repo/discovery';
import { createProgressRepo } from './repo/progress';
import { createQuestionRepo } from './repo/questions';
import { createSessionRepo } from './repo/sessions';
import { createTargetBudgetRepo } from './repo/targetBudgets';
import { createTargetReadinessRepo } from './repo/targetReadiness';
import { createTargetRepo } from './repo/targets';
import { createTargetSkillRepo } from './repo/targetSkills';
import { createEnrollmentRepo } from './repo/enrollments';
import { createGrantRepo } from './repo/grants';
import { createUserRepo } from './repo/users';
import { createDictRepo } from './repo/dictionary';
import { createVocabularyRepo } from './repo/vocabulary';
import { createModelCallRepo } from './repo/modelCalls';
import { createPronunciationRepo } from './repo/pronunciationScores';
import { createReminderRepo } from './repo/reminders';
import { createBotService, type BotService, type MintSession } from './services/bots';
import { createEnrollmentService, type EnrollmentService } from './services/enrollments';
import { createGlossService, type GlossService } from './services/glosses';
import type { LlmClient, ModelCallRecorder, VisionClient } from './services/llm';
import { createModelCallService } from './services/modelCalls';
import { createPhotoImportService, type PhotoImportService } from './services/photoImports';
import { createDiscoveryService, type DiscoveryService } from './services/discovery';
import { createReminderService, type PushSender, type ReminderService } from './services/reminders';
import { createQuestionTypesService, type QuestionTypesService } from './services/questionTypes';
import { createSessionService, type SessionService } from './services/sessions';
import { createTargetService, type TargetService } from './services/targets';
import type { SpeechTranscriber } from './services/speech';
import type { Repos } from './services/transaction';
import { EXPLAIN_THINKING } from './domain/explain';
import { DISCOVERY_THINKING } from './domain/discovery';
import { TRANSLATION_JUDGE_THINKING } from './domain/judge';
import { POINT_CHECK_THINKING, SESSION_GENERATION_THINKING } from './domain/jobs';
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
  // Phase 49. The commit, so the app's About screen can name the server's exact build.
  commit: string;
};

export type AppDeps = {
  sessions: SessionService;
  // Phase 61 (spec D2, D3). A tester's read of one word's question types, and its session.
  questionTypes: QuestionTypesService;
  users: UserService;
  enrollments: EnrollmentService;
  translations: TranslationService;
  vocabulary: VocabularyService;
  grants: GrantService;
  // Phase 52 (spec D2, D4, D6). A learner's reminder schedule, their phones, and the tap.
  reminders: ReminderService;
  photoImports: PhotoImportService;
  // Phase 69 (spec D10). Words for me: a learner's profile, runs, lists and their lookups.
  discovery: DiscoveryService;
  // Phase 53 (spec D1, D2, D10, D11). A learner's targets: made, changed, ended and read.
  targets: TargetService;
  // Phase 31 (spec D7). The merge job's use case; no route reaches it. The
  // tool's plan and apply come with the type, unused here and composed with a
  // null model: db/cli.ts builds its own through createGlossTools.
  glosses: GlossService;
  health: HealthRepo;
  identity: ServerIdentity;
  // Phase 30 (spec D1). Set only inside the image; app.ts serves the export from it.
  webDistDir: string | null;
  logger: Logger;
  // The request log on /api/*: a started and a finished line per request.
  requestLog: MiddlewareHandler;
  // Phase 29. The four mounted Better Auth paths and their handler (spec D3).
  auth: {
    handler: AuthModule['handler'];
    paths: readonly { method: 'GET' | 'POST'; path: string }[];
  };
  // Phase 29. Reads the session behind a request (spec D11). Only routes/actor.ts uses it.
  signedIn: SessionReader;
  // Phase 29 (spec D15). The browser origins CORS admits, with credentials.
  webOrigins: string[];
  // Phase 35 (spec D12). The bot route's secret and use cases, or null, which
  // leaves the route unmounted: every lane, CI and every test that sets none.
  bots: { secret: string; service: BotService } | null;
  // Phase 52 (spec D5). The reminder tick's secret and the service it asks for a run, or null,
  // which leaves the route unmounted: every lane, CI and every test that sets none.
  reminderTick: { secret: string; service: ReminderService } | null;
};

// A tool that enqueues nothing gets a jobs repository that says so.
const NO_JOBS: JobRepo = {
  enqueue: async () => {
    throw new Error('this composition enqueues no job');
  },
  enqueueOrPostpone: async () => {
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
    memory: createMemoryRepo(tx),
    glossFamilies: createGlossFamiliesRepo(tx),
    jobs: boss ? createJobRepo(tx, boss) : NO_JOBS,
    photoImport: createPhotoImportRepo(tx),
    gloss: createGlossRepo(tx),
    modelCall: createModelCallRepo(tx),
    pronunciation: createPronunciationRepo(tx),
    reminders: createReminderRepo(tx),
    target: createTargetRepo(tx),
    targetSkills: createTargetSkillRepo(tx),
    targetReadiness: createTargetReadinessRepo(tx),
    targetBudgets: createTargetBudgetRepo(tx),
    discovery: createDiscoveryRepo(tx),
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
  // Phase 34 (ruling R12). The budget of the context call after the batch: its
  // own and short, so a hang costs the sentences, not the batch's two minutes.
  contextCallTimeoutMs: number;
  // Phase 34 (spec D5, ruling R12). The checker's budget, after the context call:
  // its own, so its wait is bounded apart from the batch's two minutes.
  checkerCallTimeoutMs: number;
  // Phase 62c (spec D1). The gap check's and the rewrite's budgets: their own and
  // short, so a rescue that hangs holds a session no longer than these.
  gapCheckTimeoutMs: number;
  gapRewriteTimeoutMs: number;
  // Phase 25 (spec D13). One transcription's budget: short, because a learner
  // is waiting on a card.
  speechTimeoutMs: number;
  // Phase 26 (spec D5). One photo read's budget: a long call over an image,
  // longer than a lookup's.
  photoReadTimeoutMs: number;
  // Phase 27 (spec D4). One judged answer's budget: a learner is waiting on it.
  judgeTimeoutMs: number;
  // Phase 69 (spec D4). One round of Words for me: a learner is waiting on it.
  discoveryTimeoutMs: number;
  // Phase 43 (ruling R3). How long a save's request for a session in stock waits.
  stockSaveDelaySeconds: number;
  // Phase 50 (spec D4). The pronunciation score at which an unheard transcript is the word.
  soundAlikeThreshold: number;
  identity: ServerIdentity;
  webDistDir: string | null;
  // Phase 35 (spec D12). BOT_SECRET, or null where it is unset.
  botSecret: string | null;
  // Phase 52 (spec D7). Expo's push service; tests and e2e point it at MockServer.
  pushBaseUrl: string;
  // Phase 52 (spec D5, D9). REMINDER_SECRET, or null where it is unset: the tick route's
  // secret, which leaves the route unmounted, as botSecret does.
  reminderSecret: string | null;
  // Phase 19. Constructed and started in main() — starting it is I/O, and
  // composition performs none (ADR 0001 R6). Only the jobs repository uses it.
  boss: PgBoss;
  // A line per request when it arrives and when it finishes, with bodies or
  // without; null writes none, which keeps a test's logger to its own events.
  requestLog: { bodies: boolean } | null;
}): AppDeps {
  // Binding the repositories to a transaction is assembly, which is what this
  // file is for. Doing it here is what lets services/ take a transaction rather
  // than a database.
  const transaction = createTransaction(io.db, (tx) => bindRepos(tx, io.boss));

  // Phase 47 (spec D5). Every model client reports each request here, so the
  // prompt, the answer and the time of every call can be read afterwards. The
  // annotation checks that the recorder takes what the provider reports.
  const onCall: ModelCallRecorder = createModelCallService({ transaction, logger: io.logger, now: io.now }).record;

  // The one place in the repo that names both `createGeminiClient` and
  // `LlmClient` (ADR 0001 R11). The annotation below is what checks that the
  // provider satisfies the contract — providers/ cannot import it, exactly as
  // db/transaction.ts cannot import Transaction.
  const llm: LlmClient = createGeminiClient({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    onCall,
    now: io.now,
    timeoutMs: io.translationTimeoutMs,
  });

  // Phase 19. The same provider with its own budget: a session's distractors
  // are one long answer, and a lookup's 25 s would cut it off.
  const sessionLlm: LlmClient = createGeminiClient({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    onCall,
    now: io.now,
    timeoutMs: io.sessionGenerationTimeoutMs,
    // Phase 47 (spec D1). Uncapped, its thinking once ran to 62,910 tokens and
    // four minutes over one batch.
    thinkingBudget: SESSION_GENERATION_THINKING,
  });

  // Phase 34 (spec D6, D8, ruling R12). The same provider for the context call,
  // with its own budget: the call degrades on a timeout (ruling R11).
  const contextLlm: LlmClient = createGeminiClient({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    onCall,
    now: io.now,
    timeoutMs: io.contextCallTimeoutMs,
  });

  // Phase 34 (spec D5, ruling R12). The same provider for the checker, with its
  // own budget. Unlike the context call, a checker that times out fails the
  // attempt, which pg-boss retries.
  const checkerLlm: LlmClient = createGeminiClient({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    onCall,
    now: io.now,
    timeoutMs: io.checkerCallTimeoutMs,
  });

  // Phase 62c (spec D1, D3). The checker's prompt for a session's gap cards, beside
  // the context call, and the batch's prompt for the cards asked again: each the
  // same provider with a budget of its own, and the rewrite the batch's thinking.
  const gapCheckLlm: LlmClient = createGeminiClient({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    onCall,
    now: io.now,
    timeoutMs: io.gapCheckTimeoutMs,
  });
  // Phase 62d (spec D2). The point check: the gap check's provider and budget, its thinking capped.
  const pointCheckLlm: LlmClient = createGeminiClient({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    onCall,
    now: io.now,
    timeoutMs: io.gapCheckTimeoutMs,
    thinkingBudget: POINT_CHECK_THINKING,
  });
  const gapRewriteLlm: LlmClient = createGeminiClient({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    onCall,
    now: io.now,
    timeoutMs: io.gapRewriteTimeoutMs,
    thinkingBudget: SESSION_GENERATION_THINKING,
  });

  // Phase 25. The same provider over audio. Named here and nowhere else
  // (ADR 0001 R11); the annotation checks it satisfies the contract.
  const transcriber: SpeechTranscriber = createGeminiTranscriber({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    onCall,
    now: io.now,
    timeoutMs: io.speechTimeoutMs,
  });

  // Phase 26 (spec D5). The same provider reading a photo, with a read's budget.
  // The annotation is what checks it satisfies the contract (ADR 0001 R11).
  const vision: VisionClient = createGeminiVisionClient({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    onCall,
    now: io.now,
    timeoutMs: io.photoReadTimeoutMs,
  });

  // Phase 27 (spec D3). The judge waits on the learner, as the transcriber
  // does: its own budget, and thinking off for the wait (D4).
  const judge: LlmClient = createGeminiClient({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    onCall,
    now: io.now,
    timeoutMs: io.judgeTimeoutMs,
    thinkingBudget: 0,
  });
  // Phase 69 (spec D4). A round of Words for me, on its own client: the learner waits on
  // it at a spinner, so its budget is short and its thinking measured (DISCOVERY_THINKING).
  const discover: LlmClient = createGeminiClient({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    onCall,
    now: io.now,
    timeoutMs: io.discoveryTimeoutMs,
    thinkingBudget: DISCOVERY_THINKING,
  });
  // Phase 45 (spec D3). The translation judge thinks before it answers: with thinking
  // off it took "talk with everyone" for "communicate clearly with everyone". 512
  // tokens measured about 2.4 s a call, inside the judge's own budget.
  const translationJudge: LlmClient = createGeminiClient({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    onCall,
    now: io.now,
    timeoutMs: io.judgeTimeoutMs,
    thinkingBudget: TRANSLATION_JUDGE_THINKING,
  });
  // Phase 66 (spec D2). The explainer: the judge's timeout, and more thinking. Phase
  // 66b (spec D1): a translation's grade now waits on it beside the judge, so that
  // timeout is the grade's cap too.
  const explainer: LlmClient = createGeminiClient({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    onCall,
    now: io.now,
    timeoutMs: io.judgeTimeoutMs,
    thinkingBudget: EXPLAIN_THINKING,
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
  // Phase 52 (spec D7). The one place that names both the Expo provider and the PushSender
  // contract it satisfies (ADR 0001 R11); the annotation is what checks it.
  const push: PushSender = createExpoPushClient({
    fetch: io.fetch,
    baseUrl: io.pushBaseUrl,
    timeoutMs: PUSH_TIMEOUT_MS,
  });
  const authModule = createAuth({
    db: io.db,
    authRepo: createAuthRepo(io.db),
    secret: io.auth.secret,
    baseUrl: io.auth.baseUrl,
    webOrigins: io.auth.webOrigins,
    sendCode,
    now: io.now,
    logger: io.logger,
    reviewerCodes: io.auth.reviewerCodes,
  });

  const translations = createTranslationService({ llm, transaction, logger: io.logger, now: io.now });
  const reminders = createReminderService({ transaction, push, logger: io.logger, now: io.now });
  // Phase 35 (spec D12). The one place that hands Better Auth's session minting
  // to the use case that needs it (ADR 0001 R13).
  const mintSession: MintSession = authModule.mintSession;

  return {
    sessions: createSessionService({
      transaction,
      rng: io.rng,
      now: io.now,
      logger: io.logger,
      llm: sessionLlm,
      contextLlm,
      checkerLlm,
      gapCheckLlm,
      gapRewriteLlm,
      pointCheckLlm,
      transcriber,
      judge,
      translationJudge,
      explainer,
      soundAlikeThreshold: io.soundAlikeThreshold,
    }),
    questionTypes: createQuestionTypesService({ transaction, logger: io.logger, now: io.now }),
    users: createUserService({ transaction, logger: io.logger }),
    enrollments: createEnrollmentService({ transaction, logger: io.logger }),
    translations,
    vocabulary: createVocabularyService({ transaction, logger: io.logger, now: io.now, stockSaveDelaySeconds: io.stockSaveDelaySeconds }),
    grants: createGrantService({ transaction, logger: io.logger }),
    reminders,
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
      stockSaveDelaySeconds: io.stockSaveDelaySeconds,
    }),
    // Phase 69 (spec D4, D5, D7). Rounds on their own client; answers on the session's
    // judge; a word's lookup and its match exactly as a photo row's.
    discovery: createDiscoveryService({
      transaction,
      discover,
      judge,
      llm,
      lookup: translations.translate,
      now: io.now,
      logger: io.logger,
      stockSaveDelaySeconds: io.stockSaveDelaySeconds,
    }),
    // Phase 53 (spec D10, D11). Saves photos and typed words with the target in one
    // transaction, through the photo-import and vocabulary saves' own functions.
    targets: createTargetService({
      transaction,
      logger: io.logger,
      now: io.now,
      stockSaveDelaySeconds: io.stockSaveDelaySeconds,
    }),
    // No model composed here: the tool's tier 2 is built by createGlossTools.
    glosses: createGlossService({ transaction, logger: io.logger, llm: null }),
    health: createHealthRepo(io.db, io.logger),
    identity: io.identity,
    webDistDir: io.webDistDir,
    logger: io.logger,
    requestLog: io.requestLog
      ? createRequestLog({ logger: io.logger, now: io.now, bodies: io.requestLog.bodies })
      : passRequestsThrough,
    auth: { handler: authModule.handler, paths: authModule.paths },
    signedIn: { sessionOf: authModule.sessionOf },
    webOrigins: io.auth.webOrigins,
    bots: io.botSecret ? { secret: io.botSecret, service: createBotService({ transaction, mintSession }) } : null,
    reminderTick: io.reminderSecret ? { secret: io.reminderSecret, service: reminders } : null,
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
  // Phase 47 (review). The clock the model calls are timed and pruned by.
  now: () => number;
}): GlossService {
  const transaction = createTransaction(io.db, (tx) => bindRepos(tx, null));
  // Phase 47 (spec D5). The merge tool's calls are recorded as the server's are.
  const onCall: ModelCallRecorder = createModelCallService({ transaction, logger: io.logger, now: io.now }).record;
  const llm: LlmClient | null = io.gemini
    ? createGeminiClient({
        fetch: io.fetch,
        baseUrl: io.gemini.baseUrl,
        apiKey: io.gemini.apiKey,
        model: io.gemini.model,
        onCall,
        now: io.now,
        timeoutMs: io.timeoutMs,
      })
    : null;
  return createGlossService({ transaction, logger: io.logger, llm });
}
