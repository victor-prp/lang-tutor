const { describe, expect, it } = require('@jest/globals');

const { withEasBuildCommit } = require('./easBuildCommit');

const HASH = 'cac24f25dd0fa68387725afb5bb5dd74b10c6e06';

describe('withEasBuildCommit', () => {
  it("stamps an EAS build's commit, 7 characters, for the bundle inside the binary", () => {
    const env = { EAS_BUILD_GIT_COMMIT_HASH: HASH };
    withEasBuildCommit(env);
    expect(env.EXPO_PUBLIC_APP_COMMIT).toBe('cac24f2');
  });

  it('keeps a commit already set (with-commit.sh, the release, the image)', () => {
    const env = { EAS_BUILD_GIT_COMMIT_HASH: HASH, EXPO_PUBLIC_APP_COMMIT: 'e91c0aa-dirty' };
    withEasBuildCommit(env);
    expect(env.EXPO_PUBLIC_APP_COMMIT).toBe('e91c0aa-dirty');
  });

  it('sets nothing outside an EAS build', () => {
    const env = {};
    withEasBuildCommit(env);
    expect(env).toEqual({});
  });
});
