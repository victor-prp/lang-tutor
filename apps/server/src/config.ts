// A pure function of its argument: it reads no global, so a test hands it a
// literal object rather than mutating the process environment.
export type Config = {
  databaseUrl: string;
  port: number;
  poolMax: number;
  translationTimeoutMs: number;
};

// The one place this default lives. Both composition roots read it from here.
const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/lang_tutor';

// Measured worst case for a many-sense word (`left`) is 13.3s; 25s leaves
// real headroom above that without leaving a learner staring at a spinner
// indefinitely. Configurable so a test can inject a short budget instead of
// paying this in wall-clock time on every run.
const DEFAULT_TRANSLATION_TIMEOUT_MS = 25_000;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    // `Number('') === 0` and `Number('nonsense') === NaN`, both falsy: an unset,
    // empty or malformed value all mean "use the default".
    port: Number(env.PORT) || 3001,
    poolMax: Number(env.PG_POOL_MAX) || 5,
    translationTimeoutMs: Number(env.TRANSLATION_TIMEOUT_MS) || DEFAULT_TRANSLATION_TIMEOUT_MS,
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
