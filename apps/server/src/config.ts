// A pure function of its argument: it reads no global, so a test hands it a
// literal object rather than mutating the process environment.
export type Config = {
  databaseUrl: string;
  port: number;
  poolMax: number;
};

// The one place this default lives. Both composition roots read it from here.
const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/lang_tutor';

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    // `Number('') === 0` and `Number('nonsense') === NaN`, both falsy: an unset,
    // empty or malformed value all mean "use the default".
    port: Number(env.PORT) || 3001,
    poolMax: Number(env.PG_POOL_MAX) || 5,
  };
}
