# lang-tutor

A language-learning app for Hebrew speakers memorising English words and phrases.

Phase 1 runs entirely on mock data with a single multiple-choice question type,
so the look and feel can be judged on a real device before any server exists.

- Design: [docs/superpowers/specs/2026-08-24-lang-tutor-phase-1-design.md](docs/superpowers/specs/2026-08-24-lang-tutor-phase-1-design.md)
- Plan: [docs/superpowers/plans/2026-08-24-lang-tutor-phase-1.md](docs/superpowers/plans/2026-08-24-lang-tutor-phase-1.md)

## Layout

An npm-workspace monorepo.

| Path | What it is |
|---|---|
| `packages/core` | `@lang-tutor/core` — the API contract (`api/`), quiz rules (`domain/`), internal helpers (`utils/`). No runtime dependencies. Consumed as TypeScript source, so there is no build step. |
| `apps/mobile` | The Expo app. Screens, components, theme, Hebrew copy, and the session cursor. |
| `apps/server` | Phase 2. Does not exist yet. |

`utils/` is not in core's `exports` map, so it is unreachable from the app by
design. Anything the app needs comes from `@lang-tutor/core/api` (types) or
`@lang-tutor/core/domain` (rules).

## Running it

```bash
npm install       # from the repo root — it owns dependency resolution
npm run mobile
```

Then press `w` for the browser, or scan the QR code with Expo Go on a phone.
The interface is Hebrew and right-to-left; browser and native RTL are not
identical, so confirm layout on a real device.

## Checks

```bash
npm test          # every workspace
npm run typecheck # every workspace
```
