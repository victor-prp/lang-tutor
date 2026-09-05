import { describe, expect, it } from '@jest/globals';

import { loadConfig } from './config';

// Literal env objects in, Config out. No process.env is read or written here —
// which is the whole point of taking `env` as a parameter.
describe('loadConfig', () => {
  it('falls back to the development defaults for an empty environment', () => {
    expect(loadConfig({})).toEqual({
      databaseUrl: 'postgres://postgres:postgres@localhost:5432/lang_tutor',
      port: 3001,
      poolMax: 5,
    });
  });

  it('takes every value from the environment when it is set', () => {
    expect(
      loadConfig({
        DATABASE_URL: 'postgres://u:p@db:5432/other',
        PORT: '8080',
        PG_POOL_MAX: '20',
      }),
    ).toEqual({
      databaseUrl: 'postgres://u:p@db:5432/other',
      port: 8080,
      poolMax: 20,
    });
  });

  it('falls back when a numeric variable is not a number', () => {
    expect(loadConfig({ PORT: 'nonsense', PG_POOL_MAX: '' }).port).toBe(3001);
    expect(loadConfig({ PORT: 'nonsense', PG_POOL_MAX: '' }).poolMax).toBe(5);
  });
});
