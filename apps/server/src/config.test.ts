import { describe, expect, it } from '@jest/globals';

import { loadConfig, loadGeminiConfig } from './config';

// Literal env objects in, Config out. No process.env is read or written here —
// which is the whole point of taking `env` as a parameter.
describe('loadConfig', () => {
  it('falls back to the development defaults for an empty environment', () => {
    expect(loadConfig({})).toEqual({
      databaseUrl: 'postgres://postgres:postgres@localhost:5432/lang_tutor',
      port: 3001,
      poolMax: 5,
      translationTimeoutMs: 25_000,
    });
  });

  it('takes every value from the environment when it is set', () => {
    expect(
      loadConfig({
        DATABASE_URL: 'postgres://u:p@db:5432/other',
        PORT: '8080',
        PG_POOL_MAX: '20',
        TRANSLATION_TIMEOUT_MS: '12000',
      }),
    ).toEqual({
      databaseUrl: 'postgres://u:p@db:5432/other',
      port: 8080,
      poolMax: 20,
      translationTimeoutMs: 12_000,
    });
  });

  it('falls back when a numeric variable is not a number', () => {
    expect(loadConfig({ PORT: 'nonsense', PG_POOL_MAX: '' }).port).toBe(3001);
    expect(loadConfig({ PORT: 'nonsense', PG_POOL_MAX: '' }).poolMax).toBe(5);
    expect(loadConfig({ TRANSLATION_TIMEOUT_MS: 'nonsense' }).translationTimeoutMs).toBe(25_000);
  });

  it('still works with no Gemini settings at all, so db:migrate is unaffected', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(config.databaseUrl).toContain('postgres://');
    expect(config.port).toBe(3001);
  });
});

describe('loadGeminiConfig', () => {
  const complete = {
    GEMINI_API_KEY: 'k',
    GEMINI_MODEL: 'gemini-flash-test',
  } as NodeJS.ProcessEnv;

  it('reads the three settings', () => {
    expect(loadGeminiConfig({ ...complete, GEMINI_BASE_URL: 'http://localhost:1080/ns' })).toEqual({
      apiKey: 'k',
      baseUrl: 'http://localhost:1080/ns',
      model: 'gemini-flash-test',
    });
  });

  it('defaults the base URL to Google, because production is the common case', () => {
    expect(loadGeminiConfig(complete).baseUrl).toBe('https://generativelanguage.googleapis.com');
  });

  it('throws when the key is absent, rather than failing at the first lookup', () => {
    expect(() => loadGeminiConfig({ GEMINI_MODEL: 'm' } as NodeJS.ProcessEnv)).toThrow(
      /GEMINI_API_KEY/,
    );
  });

  it('throws when the key is blank', () => {
    expect(() =>
      loadGeminiConfig({ ...complete, GEMINI_API_KEY: '  ' } as NodeJS.ProcessEnv),
    ).toThrow(/GEMINI_API_KEY/);
  });

  it('throws when the model is absent — there is no safe default to guess', () => {
    expect(() => loadGeminiConfig({ GEMINI_API_KEY: 'k' } as NodeJS.ProcessEnv)).toThrow(
      /GEMINI_MODEL/,
    );
  });

  // Caught on the message rather than handed to `.toThrow` as an asymmetric
  // matcher: `toThrow` applies one of those to the thrown Error *object*, where
  // `expect.not.stringContaining` is vacuously true. The key here is a value no
  // legitimate message would contain by accident.
  it('never puts the key in the error message', () => {
    expect(() =>
      loadGeminiConfig({ GEMINI_API_KEY: 'sk-leaked-secret-42' } as NodeJS.ProcessEnv),
    ).toThrow(/GEMINI_MODEL/);
    try {
      loadGeminiConfig({ GEMINI_API_KEY: 'sk-leaked-secret-42' } as NodeJS.ProcessEnv);
    } catch (error) {
      expect((error as Error).message).not.toContain('sk-leaked-secret-42');
    }
  });
});
