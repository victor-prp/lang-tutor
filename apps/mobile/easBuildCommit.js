// Phase 49 follow-up. The bundle inside a new Android binary is built on Expo's
// servers, where the release's EXPO_PUBLIC_APP_COMMIT never arrives, so About
// could only say `built-in`. EAS Build sets EAS_BUILD_GIT_COMMIT_HASH on its
// workers, so the commit becomes known there: the line reads `built-in (cac24f2)`.
// A commit already set wins (scripts/with-commit.sh, android-release.sh, the image).
//
// Plain CommonJS: metro.config.js requires it before Metro reads the environment.
function withEasBuildCommit(env) {
  const hash = env.EAS_BUILD_GIT_COMMIT_HASH;
  if (!env.EXPO_PUBLIC_APP_COMMIT && hash) env.EXPO_PUBLIC_APP_COMMIT = hash.slice(0, 7);
  return env;
}

module.exports = { withEasBuildCommit };
