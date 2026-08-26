# lang-tutor

A language-learning app for Hebrew speakers memorising English words and phrases.

Phase 1 ran entirely on mock data with a single multiple-choice question type. Phase 2
adds a server: it creates sessions, tracks progress, scores answers, and logs each
completed session — all in memory, no database yet. The learner-facing app is unchanged.

- Phase 1: [design](docs/superpowers/specs/2026-08-24-lang-tutor-phase-1-design.md) · [plan](docs/superpowers/plans/2026-08-24-lang-tutor-phase-1.md)
- Phase 2: [design](docs/superpowers/specs/2026-08-26-lang-tutor-phase-2-design.md) · [plan](docs/superpowers/plans/2026-08-26-lang-tutor-phase-2.md)

## Layout

An npm-workspace monorepo.

| Path | What it is |
|---|---|
| `packages/core` | `@lang-tutor/core` — the API contract (`api/`), quiz rules (`domain/`), internal helpers (`utils/`). No runtime dependencies. Consumed as TypeScript source, so there is no build step. |
| `apps/mobile` | The Expo app. Screens, components, theme, Hebrew copy, and the API client. |
| `apps/server` | A Hono server on `@hono/node-server`. In-memory session state — no database. Owns the question pool and the quiz's progress; the app talks to it over HTTP. Also consumed as TypeScript source via `tsx`, no build step. |

`utils/` is not in core's `exports` map, so it is unreachable from either app by
design. Anything a consumer needs comes from `@lang-tutor/core/api` (types) or
`@lang-tutor/core/domain` (rules) — both `apps/mobile` and `apps/server` import them.

## Running it

Two processes: the server, then the app.

```bash
npm install       # from the repo root — it owns dependency resolution
npm run server    # terminal 1 — binds 0.0.0.0:3001 by default
npm run mobile    # terminal 2
```

Then press `w` for the browser, or scan the QR code with Expo Go on a phone. The
interface is Hebrew and right-to-left; browser and native RTL are not identical, so
confirm layout on a real device.

**Testing on a physical device:** the phone needs a real IP to reach the server —
`localhost` only works for the web target and simulators, which share the dev machine's
network namespace.

```bash
cp apps/mobile/.env.example apps/mobile/.env.local
# edit apps/mobile/.env.local: set EXPO_PUBLIC_API_URL to your dev machine's LAN IP
# (macOS: ipconfig getifaddr en0), then restart `npm run mobile`
```

Phone and dev machine must be on the same Wi-Fi network.

## Checks

```bash
npm test          # every workspace, including apps/server's real-HTTP integration test
npm run typecheck # every workspace
```
