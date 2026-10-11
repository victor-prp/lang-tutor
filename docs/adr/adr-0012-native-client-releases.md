# ADR 0012: The Android app ships with every release, by fingerprint, behind an API level

- **Status:** Accepted
- **Date:** 2026-10-11
- **Source:** [phase 32 design](../superpowers/specs/2026-10-11-lang-tutor-phase-32-android-app-design.md) — D3 for the runtime version, D4–D6 for the release job, D9 for the API level

## Decision

The Android app is a client that can be older than the server it calls. Play installs a new build
on its own schedule, and an over-the-air update reaches only builds with the same native layer.
Three things keep that safe:

```
  release.yml   guard ─► build-push ─► apply (/health = tag) ─► android
                                                                 │ fingerprint of the tag
                                                                 ├─ = newest build: eas update   (minutes)
                                                                 └─ ≠ newest build: eas build → submit (internal) → update
  app           runtimeVersion = fingerprint ── an update lands only on a matching build
  every call    X-Api-Level: API_LEVEL ──► server: lower → 426 ──► "update required" screen
```

The app ships after the server is live, so new app code never calls an older server. The
runtime version is the fingerprint, so JavaScript never lands on native code it was not built
against. `API_LEVEL` in `packages/core/src/apiLevel.ts` is the wire contract's compatibility
level, so an app the server has left behind is told to update instead of failing.

## Rules

| # | Subject | Must | Must not |
|---|---|---|---|
| R1 | `apps/mobile/app.json` | set `runtimeVersion` to `{ "policy": "fingerprint" }` | use a hand-set runtime version, or `appVersion` / `nativeVersion` |
| R2 | `.github/workflows/release.yml`, job `android` | declare `needs: apply` | run before the server answers `/health` with the tag |
| R3 | the header `X-Api-Level` | be written in `packages/core/src/apiLevel.ts` | be written as a literal in any other non-test `.ts`/`.tsx` under `apps/server/src`, `apps/mobile/src` or `packages/core/src` |
| R4 | `apps/mobile/eas.json` | submit to `"track": "internal"` | submit to any other track |

## Rules that are not import rules

- **A change that breaks older clients raises `API_LEVEL` by one, in the same PR.** No command
  can tell a breaking change from a compatible one. Enforced by review: a PR that removes or
  renames a response field, adds a required request field, or changes a meaning must touch
  `apiLevel.ts`.

## How to detect a violation

`npm run lint:arch` runs the four commands below alongside the other ADRs';
`scripts/check-adr-0012-native-client-releases.sh` mirrors this block verbatim. Paste the block
at the repo root, then run `r1` to `r4`: each must print nothing.

```bash
# R1 — the runtime version is the fingerprint, so an update reaches only a matching build.
r1() { grep -L '"policy": "fingerprint"' apps/mobile/app.json; }

# R2 — the android job runs after apply, whose last step waits for /health to name the tag.
r2() { awk '/^  android:$/ { f = 1; next } f && /^  [a-z-]+:$/ { exit } f' .github/workflows/release.yml | grep -q '^    needs: apply$' || echo '.github/workflows/release.yml: job android does not need apply'; }

# R3 — the API level header is named in one place, so the app and the server cannot drift.
r3() { grep -rni "x-api-level" apps/server/src apps/mobile/src packages/core/src --include='*.ts' --include='*.tsx' | grep -v -e '^packages/core/src/apiLevel\.ts:' -e '\.test\.ts:'; }

# R4 — builds go to Play's internal track, the friends-only list, and nowhere public.
r4() { grep -L '"track": "internal"' apps/mobile/eas.json; }
```

### What the rules cover

- R1 and R4 read one file each: `app.json` and `eas.json` in `apps/mobile`.
- R2 reads the `android` job of `release.yml`, up to the next job.
- R3 scans `apps/server/src`, `apps/mobile/src` and `packages/core/src`, case-insensitively.
- Test files (`*.test.ts`) are excluded from R3: they send and assert the header by name on purpose.

## Why

- **R1:** with any other policy, a JavaScript update that needs a new native module would reach
  builds without it and crash them on launch.
- **R2:** an app update published before the server serves the new API would call endpoints
  that are not there yet, on every friend's phone at once.
- **R4:** another track would publish the app beyond the tester list, which this phase's scope
  rules out.

## Related

- ADR 0002 R1: `expo-updates` is imported only at `_layout.tsx`.
- ADR 0003: the wire contract `API_LEVEL` versions.
- ADR 0009: Better Auth's own calls do not carry the header and are not gated.
