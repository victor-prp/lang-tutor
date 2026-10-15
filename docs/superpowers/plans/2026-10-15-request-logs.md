# Request logs Implementation Plan

> **For agentic workers:** executed inline with superpowers:executing-plans ("go till PR").
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every `/api` request leaves a started and a finished line, everywhere; every lane's
server and Metro output is also saved under `<checkout>/.logs/`.

**Architecture:** a Hono middleware in `routes/requestLog.ts` logs through the existing `Logger`;
`scripts/with-log.sh` tees a command's output into a timestamped file, under `script` for Metro.

**Tech Stack:** Hono 4, Jest (server unit project), bash, perl (timestamps), `script`.

**Spec:** `docs/superpowers/specs/2026-10-15-lang-tutor-request-logs-design.md`

## Global Constraints

- Only `/api/*` is logged; `/health` never.
- Bodies: JSON only; request `content-length` > 256 KB not read; strings > 2 000 chars omitted.
- Masked: headers `cookie`, `authorization`; JSON keys ending `token|password|secret|otp` (any case).
- `console` only in `logger.ts`/`index.ts` (ADR 0001 R7); no literal ports in scripts (ADR 0006 R1).
- Rotation at 50 MB to `<name>.log.1`.

## Review Focus

- A handler that reads the body after the middleware cloned it (Better Auth reads `c.req.raw`) — must still get the body.
- A request body that is not valid JSON despite a JSON content type — logged as omitted, request unaffected.
- A logging failure (clone/parse throws) — never fails the request.
- Ctrl-C on `npm run server` / `npm run mobile` — the command still gets the signal and the exit code is the command's.
- Metro run under `script` without a terminal (a Claude shell) — runs plainly instead of failing.

---

### Task 1: The request-log middleware

**Files:** Create `apps/server/src/routes/requestLog.ts`, `apps/server/src/routes/requestLog.test.ts`.

**Produces:** `createRequestLog({ logger, now, bodies }): MiddlewareHandler`, `redactHeaders(h: Headers): Record<string,string>`, `redactBody(value: unknown): unknown`.

- [ ] Write tests (bare `Hono` app, recording logger, fake `now`): started+finished with same `req`,
  status, `duration_ms`; thrown error → finished 500 (app has `onError`); never-resolving handler →
  only started; masked headers and nested JSON keys; long string omitted; oversized
  `content-length` omitted without reading; non-JSON summarised; malformed JSON omitted; handler
  still reads body; `bodies: false` → no `body` keys.
- [ ] Run, see them fail; implement; run, see them pass; commit.

### Task 2: Wire it in

**Files:** Modify `apps/server/src/app.ts`, `apps/server/src/composition.ts` (deps carry it),
`apps/server/src/index.ts`, `apps/server/src/app.test.ts`.

- [ ] Test in `app.test.ts`: a request to `/api/me` logs `request_started`/`request_finished`; `/health` logs nothing.
- [ ] Register `app.use('/api/*', deps.requestLog)` first, before CORS; build it in the composition root with `bodies: true`.
- [ ] `npm test --workspace apps/server`, `npm run typecheck`, `npm run lint:arch`; commit.

### Task 3: `scripts/with-log.sh`

**Files:** Create `scripts/with-log.sh`, `scripts/test-with-log.sh`; modify `.github/workflows/ci.yml`.

- [ ] Write `test-with-log.sh` (mktemp `LANE_LOGS`): terminal output unchanged; file lines
  timestamped `YYYY-MM-DD HH:MM:SS.mmm `; stderr captured; exit code passed through; ANSI stripped
  in file; start line; rotation over a lowered limit (`WITH_LOG_MAX_BYTES`); `--tty` with stdin not a tty runs plainly; missing `LANE_LOGS` refuses.
- [ ] Implement; run the test; add it to CI's `check-adrs` job; commit.

### Task 4: Lanes run through it

**Files:** Modify `scripts/lane-env.sh` (`LANE_LOGS`), `scripts/test-lane-env.sh`, root
`package.json` (`server`, `mobile`), `.gitignore` (`.logs/`), `CLAUDE.md` (where logs are).

- [ ] Add `LANE_LOGS` to the test, then to `lane-env.sh`; `bash scripts/test-lane-env.sh`.
- [ ] Update the two scripts, `.gitignore`, CLAUDE.md; `npm run lint:arch`.
- [ ] Smoke: `npm run server` in this lane, curl `/api/me` and `/health`, read `.logs/server.log`; commit.
