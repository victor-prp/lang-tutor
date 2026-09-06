// A .js config rather than a JSON block in package.json or a .ts file: the two
// projects need comments to explain *why* they differ, JSON cannot carry them,
// and a TypeScript config would need ts-node, which is not installed — adding a
// dependency just to parse config is not worth it.
module.exports = {
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
      testTimeout: 30000, // a clone plus a pool connection is slower than a pure unit test
      // Same ESM-only-dependency issue as the unit project: these tests also
      // transitively import createApp/app.ts. Jest's multi-project config does
      // not inherit top-level options per-project, so this is set on both.
      transformIgnorePatterns: ['/node_modules/(?!@scalar)/'],
    },
  ],
};
