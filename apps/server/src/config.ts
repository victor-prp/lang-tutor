import {
  CHECKER_CALL_BUDGET_MS,
  CONTEXT_CALL_BUDGET_MS,
  GAP_CHECK_BUDGET_MS,
  GAP_REWRITE_BUDGET_MS,
  PHOTO_READ_BUDGET_MS,
  SESSION_GENERATION_BUDGET_MS,
  STOCK_SAVE_DELAY_SECONDS,
} from './domain/jobs';
import { isDeliverable, normalizeEmail } from './domain/auth';
import { soundAlikeThreshold } from './domain/soundAlike';

// A pure function of its argument: it reads no global, so a test hands it a
// literal object rather than mutating the process environment.
export type Config = {
  databaseUrl: string;
  lane: string;
  port: number;
  poolMax: number;
  translationTimeoutMs: number;
  sessionGenerationTimeoutMs: number;
  contextCallTimeoutMs: number;
  checkerCallTimeoutMs: number;
  gapCheckTimeoutMs: number;
  gapRewriteTimeoutMs: number;
  speechTimeoutMs: number;
  judgeTimeoutMs: number;
  photoReadTimeoutMs: number;
  // Phase 43 (ruling R3). How long a save's request for a session in stock waits.
  stockSaveDelaySeconds: number;
  // Phase 50 (spec D4). The pronunciation score at which an unheard transcript
  // is the card's word.
  soundAlikeThreshold: number;
  // Phase 30 (spec D2). The release tag the image was built from, published on
  // /health so a release can prove which image answers. `dev` everywhere else.
  version: string;
  // Phase 49 (spec D3). The commit the image was built from, beside the tag on /health.
  commit: string;
  // Phase 30 (spec D1). Where the web export sits inside the image. Unset, the
  // server answers the API only, which is every lane and every test: there,
  // Metro or `expo serve` serves the app.
  webDistDir: string | null;
  // Phase 52 (spec D7). Expo's push service. Tests and e2e point it at a MockServer
  // namespace, as RESEND_BASE_URL is.
  pushBaseUrl: string;
};

// The one place this default lives. Both composition roots read it from here.
const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/lang_tutor';

// Measured worst case for a many-sense word (`left`) is 13.3s; 25s leaves
// real headroom above that without leaving a learner staring at a spinner
// indefinitely. Configurable so a test can inject a short budget instead of
// paying this in wall-clock time on every run.
const DEFAULT_TRANSLATION_TIMEOUT_MS = 25_000;

// Phase 25 (spec D13). One transcription, which the POC measured at 1.5–2 s.
// Past this the card says it could not check and offers another try.
const DEFAULT_SPEECH_TIMEOUT_MS = 8_000;

// Phase 27 (spec D4). One judged answer: the learner waits on it, as on a transcription.
const DEFAULT_JUDGE_TIMEOUT_MS = 8_000;

const DEFAULT_PUSH_BASE_URL = 'https://exp.host';

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    // Which checkout this server belongs to. `main` is the main checkout, and
    // the default, so an unset environment is lane 0 — see scripts/lane-env.sh.
    lane: env.LANE?.trim() || 'main',
    // `Number('') === 0` and `Number('nonsense') === NaN`, both falsy: an unset,
    // empty or malformed value all mean "use the default".
    port: Number(env.PORT) || 3001,
    poolMax: Number(env.PG_POOL_MAX) || 5,
    translationTimeoutMs: Number(env.TRANSLATION_TIMEOUT_MS) || DEFAULT_TRANSLATION_TIMEOUT_MS,
    // Victor's cap: two minutes at most (phase 47 D1; five before it). The
    // prepare-session job expires at twice the sum of its calls' budgets
    // (PREPARE_SESSION_CALL_BUDGETS_MS), so a call longer than its budget would
    // be cut off by the expiry rather than by its own timeout: each is capped
    // at its budget, never above.
    sessionGenerationTimeoutMs: Math.min(
      Number(env.SESSION_GENERATION_TIMEOUT_MS) || SESSION_GENERATION_BUDGET_MS,
      SESSION_GENERATION_BUDGET_MS,
    ),
    // Phase 34 (ruling R12). The context call after the batch, capped the same way.
    contextCallTimeoutMs: Math.min(
      Number(env.CONTEXT_CALL_TIMEOUT_MS) || CONTEXT_CALL_BUDGET_MS,
      CONTEXT_CALL_BUDGET_MS,
    ),
    // Phase 34 (spec D5, ruling R12). The checker after the context call, capped the same way.
    checkerCallTimeoutMs: Math.min(
      Number(env.CHECKER_CALL_TIMEOUT_MS) || CHECKER_CALL_BUDGET_MS,
      CHECKER_CALL_BUDGET_MS,
    ),
    // Phase 62c (spec D1). The gap check and the rewrite, capped the same way.
    gapCheckTimeoutMs: Math.min(Number(env.GAP_CHECK_TIMEOUT_MS) || GAP_CHECK_BUDGET_MS, GAP_CHECK_BUDGET_MS),
    gapRewriteTimeoutMs: Math.min(Number(env.GAP_REWRITE_TIMEOUT_MS) || GAP_REWRITE_BUDGET_MS, GAP_REWRITE_BUDGET_MS),
    speechTimeoutMs: Number(env.SPEECH_TIMEOUT_MS) || DEFAULT_SPEECH_TIMEOUT_MS,
    judgeTimeoutMs: Number(env.JUDGE_TIMEOUT_MS) || DEFAULT_JUDGE_TIMEOUT_MS,
    // Phase 26 (spec D6). A read's budget, capped like generation's: the
    // read-photo job expires at twice PHOTO_READ_BUDGET_MS.
    photoReadTimeoutMs: Math.min(
      Number(env.PHOTO_READ_TIMEOUT_MS) || PHOTO_READ_BUDGET_MS,
      PHOTO_READ_BUDGET_MS,
    ),
    // Phase 43 (ruling R3). e2e sets it past the length of a run, so only the
    // home screen's create builds a spec's first list session.
    stockSaveDelaySeconds: Number(env.STOCK_SAVE_DELAY_SECONDS) || STOCK_SAVE_DELAY_SECONDS,
    soundAlikeThreshold: soundAlikeThreshold(env.SOUND_ALIKE_THRESHOLD),
    version: env.APP_VERSION?.trim() || 'dev',
    // 7 characters, `-dirty` from a tree with uncommitted changes; `unknown`
    // when nothing set it (spec D2).
    commit: env.APP_COMMIT?.trim() || 'unknown',
    webDistDir: env.WEB_DIST_DIR?.trim() || null,
    pushBaseUrl: env.PUSH_BASE_URL?.trim() || DEFAULT_PUSH_BASE_URL,
  };
}

/**
 * The provider settings, read separately from Config on purpose.
 *
 * `db/cli.ts` calls loadConfig too, and a migration has no use for an LLM key —
 * folding these into Config would make `npm run db:migrate` fail without one.
 */
export type GeminiConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';

/**
 * Throws rather than defaulting. A missing key must fail at startup, not at the
 * moment a learner taps the button — the same reasoning that removed the
 * language defaults from `users` in phase 8: a default can only mask a bug.
 * There is deliberately no `GEMINI_MODEL` default either, because guessing a
 * model id silently changes what the app costs and how it answers.
 */
export function loadGeminiConfig(env: NodeJS.ProcessEnv): GeminiConfig {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not set. Set it to a real key, or point GEMINI_BASE_URL at ' +
        'local MockServer (http://localhost:1080/<namespace>) with any dummy value.',
    );
  }

  const model = env.GEMINI_MODEL?.trim();
  if (!model) {
    throw new Error('GEMINI_MODEL is not set (for example: a current Gemini Flash model id).');
  }

  return { apiKey, baseUrl: env.GEMINI_BASE_URL?.trim() || DEFAULT_GEMINI_BASE_URL, model };
}

/**
 * Phase 29 (spec D17). Sign-in settings, read separately from Config for the
 * reason GeminiConfig is: db/cli.ts calls loadConfig, and a migration needs
 * none of these. Throws rather than defaulting, so a server that cannot send
 * a code fails at start-up, not when a learner taps "send code".
 */
export type AuthConfig = {
  secret: string;
  baseUrl: string;
  webOrigins: string[];
  resendApiKey: string;
  resendBaseUrl: string;
  mailFrom: string;
  /** Store reviewer accounts (spec D1): normalised email → its fixed 8-digit code. */
  reviewerCodes: ReadonlyMap<string, string>;
};

const DEFAULT_RESEND_BASE_URL = 'https://api.resend.com';

function required(env: NodeJS.ProcessEnv, name: string, hint: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. ${hint}`);
  return value;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const secret = required(env, 'BETTER_AUTH_SECRET', 'Generate one with: openssl rand -base64 32');
  if (secret.length < 32) throw new Error('BETTER_AUTH_SECRET must be at least 32 characters.');
  const webOrigins = required(env, 'WEB_ORIGINS', 'scripts/lane-env.sh derives it for a lane.')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (webOrigins.length === 0) throw new Error('WEB_ORIGINS holds no origin.');
  return {
    secret,
    baseUrl: required(env, 'AUTH_BASE_URL', 'scripts/lane-env.sh derives it for a lane.'),
    webOrigins,
    resendApiKey: required(
      env,
      'RESEND_API_KEY',
      'Use a send-only Resend key, or point RESEND_BASE_URL at MockServer with any dummy value.',
    ),
    resendBaseUrl: env.RESEND_BASE_URL?.trim() || DEFAULT_RESEND_BASE_URL,
    mailFrom: required(env, 'MAIL_FROM', 'For example: WordsPal <code@wordspal.ai>'),
    reviewerCodes: parseReviewerCodes(env.REVIEWER_CODES),
  };
}

/**
 * Store reviewer accounts (spec D1). `email=code` pairs joined by commas, a prod
 * secret only; unset, as on every lane, it is no account at all. A bad pair
 * fails start-up by its position, never by its value: the value is a credential.
 */
function parseReviewerCodes(raw: string | undefined): ReadonlyMap<string, string> {
  const codes = new Map<string, string>();
  const pairs = (raw ?? '')
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean);
  pairs.forEach((pair, index) => {
    const fail = (why: string): never => {
      throw new Error(`REVIEWER_CODES pair ${index + 1}: ${why}. Write each as email=code, the code 8 digits.`);
    };
    const [rawEmail, code, ...rest] = pair.split('=').map((part) => part.trim());
    if (!rawEmail || code === undefined || rest.length > 0) fail('not email=code');
    const email = normalizeEmail(rawEmail!);
    if (!/^\d{8}$/.test(code!)) fail('the code is not 8 digits');
    if (!isDeliverable(email)) fail('the address is undeliverable');
    if (codes.has(email)) fail('the address is listed twice');
    codes.set(email, code!);
  });
  return codes;
}

/**
 * Phase 35 (spec D12). BOT_SECRET, which mounts the bot route, or null where it
 * is unset: every lane, CI and tests. Read separately from Config for the
 * reason AuthConfig is: db/cli.ts calls loadConfig and has no use for it. A
 * secret too short to resist guessing fails at start-up; the value is never
 * printed.
 */
export function loadBotSecret(env: NodeJS.ProcessEnv): string | null {
  const secret = env.BOT_SECRET?.trim();
  if (!secret) return null;
  if (secret.length < 32) throw new Error('BOT_SECRET must be at least 32 characters. Generate one with: openssl rand -base64 32');
  return secret;
}

/**
 * Phase 52 (spec D5, D9). REMINDER_SECRET, which mounts the reminder tick route, or null where
 * it is unset: every lane, CI and tests. Read separately from Config for the reason
 * loadBotSecret is: db/cli.ts calls loadConfig and has no use for it. A secret too short to
 * resist guessing fails at start-up; the value is never printed.
 */
export function loadReminderSecret(env: NodeJS.ProcessEnv): string | null {
  const secret = env.REMINDER_SECRET?.trim();
  if (!secret) return null;
  if (secret.length < 32) throw new Error('REMINDER_SECRET must be at least 32 characters. Generate one with: openssl rand -base64 32');
  return secret;
}

/**
 * The database name inside a connection string. `/health` publishes it and the
 * lane tooling drops by it, so it is parsed once, here, rather than with a
 * regex at each call site.
 */
export function databaseNameFrom(databaseUrl: string): string {
  return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
}

/**
 * The same server, same credentials, pointed at the maintenance database.
 * CREATE DATABASE and DROP DATABASE cannot run from inside their target.
 */
export function maintenanceUrlFor(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}

/**
 * The URL with its password replaced, for anything that prints it. Production's
 * container log keeps every line, so a printed password outlives the process.
 */
export function redactDatabaseUrl(databaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return '<unparseable database URL>';
  }
  if (url.password) url.password = '***';
  return url.toString();
}

/**
 * Throws unless `name` is a bare lowercase Postgres identifier.
 *
 * An identifier cannot be a bound parameter, so any CREATE/DROP DATABASE has to
 * interpolate it. Every name that reaches one comes from scripts/lane-env.sh,
 * which emits `[a-z0-9_]` only; this is the assertion that says so out loud
 * rather than trusting it.
 */
export function assertDatabaseIdentifier(name: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`refusing ${JSON.stringify(name)} as a database identifier`);
  }
}
