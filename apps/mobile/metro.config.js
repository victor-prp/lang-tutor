// Metro's cache, keyed on the EXPO_PUBLIC_* values Metro inlines.
//
// `expo/metro-config` puts the transform cache in os.tmpdir()/metro-cache — one
// directory shared by every checkout on the machine — and Metro's cache key does
// NOT include the EXPO_PUBLIC_* values the Expo babel transform inlines. A
// cached module therefore comes back carrying whatever EXPO_PUBLIC_API_URL was
// set when it was first transformed, wherever that was.
//
// This is not theoretical. An `expo export` in a phase-15 worktree, with
// EXPO_PUBLIC_API_URL=http://localhost:4002 explicitly set, produced a bundle
// containing requireEnvValue("http://localhost:3101", 'EXPO_PUBLIC_API_URL') —
// nightly-qa's port, inlined by a different checkout's export. The app then
// silently called the wrong server, which is the exact failure lanes exist to
// make impossible (ADR 0006 R5).
//
// Two consumers in ONE checkout hit this too: `npm run mobile` builds against
// this lane's dev port and `npm run e2e` against its e2e port, so keying the
// cache on the checkout alone would not be enough.
//
// Import from `expo/metro-config`, not `@expo/metro-config`: the Expo docs are
// explicit that the re-export is what keeps the version consistent.
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const { getDefaultConfig } = require('expo/metro-config');
const { FileStore } = require('@expo/metro/metro-cache');

const config = getDefaultConfig(__dirname);

// Everything Metro inlines but does not key on. Sorted, so the digest depends on
// the values rather than on the order the environment happens to list them in.
const inlined = Object.entries(process.env)
  .filter(([name]) => name.startsWith('EXPO_PUBLIC_'))
  .sort(([a], [b]) => a.localeCompare(b));
const key = crypto.createHash('sha1').update(JSON.stringify(inlined)).digest('hex').slice(0, 12);

config.cacheStores = [new FileStore({ root: path.join(os.tmpdir(), `metro-cache-${key}`) })];

module.exports = config;
