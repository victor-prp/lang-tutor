import { PHOTO_READ_BUDGET_MS, SESSION_GENERATION_BUDGET_MS } from './domain/jobs';

// A pure function of its argument: it reads no global, so a test hands it a
// literal object rather than mutating the process environment.
export type Config = {
  databaseUrl: string;
  lane: string;
  port: number;
  poolMax: number;
  translationTimeoutMs: number;
  sessionGenerationTimeoutMs: number;
  speechTimeoutMs: number;
  judgeTimeoutMs: number;
  photoReadTimeoutMs: number;
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
    // Victor's cap: five minutes at most. The prepare-session job expires at
    // twice SESSION_GENERATION_BUDGET_MS, so a longer call would be cut off by
    // the expiry rather than by its own timeout.
    sessionGenerationTimeoutMs: Math.min(
      Number(env.SESSION_GENERATION_TIMEOUT_MS) || SESSION_GENERATION_BUDGET_MS,
      SESSION_GENERATION_BUDGET_MS,
    ),
    speechTimeoutMs: Number(env.SPEECH_TIMEOUT_MS) || DEFAULT_SPEECH_TIMEOUT_MS,
    judgeTimeoutMs: Number(env.JUDGE_TIMEOUT_MS) || DEFAULT_JUDGE_TIMEOUT_MS,
    // Phase 26 (spec D6). A read's budget, capped like generation's: the
    // read-photo job expires at twice PHOTO_READ_BUDGET_MS.
    photoReadTimeoutMs: Math.min(
      Number(env.PHOTO_READ_TIMEOUT_MS) || PHOTO_READ_BUDGET_MS,
      PHOTO_READ_BUDGET_MS,
    ),
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
    mailFrom: required(env, 'MAIL_FROM', 'For example: WordsPal <code@mail.wordspal.ai>'),
  };
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
