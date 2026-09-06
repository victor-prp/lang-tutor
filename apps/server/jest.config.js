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
    },
  ],
};
