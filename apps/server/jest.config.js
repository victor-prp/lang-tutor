// A .js config rather than a JSON block in package.json or a .ts file: the two
// projects need comments to explain *why* they differ, JSON cannot carry them,
// and a TypeScript config would need ts-node, which is not installed — adding a
// dependency just to parse config is not worth it.
module.exports = {
  // Top level, not inside a project: Jest rejects `testTimeout` as an unknown
  // option when it appears in a `projects[]` entry, and silently discards it —
  // the only sign is a validation warning, so for a while every integration
  // test ran at the 5000 ms default the config believed it had overridden. A
  // clone plus a pool connection is slower than a pure unit test, and the
  // database-dropping afterAll hooks overran 5s often enough to fail roughly
  // one integration run in three.
  //
  // This applies to the unit project too. That costs nothing on a passing run
  // and only delays the report of a genuinely hung unit test, which is a much
  // better trade than a flaky suite.
  testTimeout: 30000,
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      // Folder decides the bucket. No allowlist for anyone to remember to update.
      testMatch: ['<rootDir>/src/**/*.test.ts'],
      restoreMocks: true,
      resetMocks: true,
      // @scalar/hono-api-reference (and its own @scalar/client-side-rendering
      // dependency) ship ESM-only, no CJS build. Jest's default pattern skips
      // all of node_modules, so without this override anything importing
      // app.ts fails with "Cannot use import statement outside a module".
      transformIgnorePatterns: ['/node_modules/(?!@scalar)/'],
      // No globalSetup: nothing here may touch Postgres. That is the whole point,
      // and CI's test-unit job (which has no database at all) enforces it.
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
      globalSetup: '<rootDir>/tests/support/globalSetup.ts',
      globalTeardown: '<rootDir>/tests/support/globalTeardown.ts',
      restoreMocks: true,
      resetMocks: true,
      // Same ESM-only-dependency issue as the unit project: these tests also
      // transitively import createApp/app.ts. A `projects[]` entry does not
      // inherit this from the top level, so it is set on both — unlike
      // `testTimeout` above, which is only valid at the top level. Which
      // options inherit is per-option; check the validation warnings.
      transformIgnorePatterns: ['/node_modules/(?!@scalar)/'],
    },
  ],
};
