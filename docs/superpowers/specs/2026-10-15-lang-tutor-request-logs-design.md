# Request logs — every request on record, every lane's output on disk

- **Status:** Scoped with Victor on 2026-10-15 (one-pager, four scope answers). Then "go till PR":
  the design below is self-approved (CLAUDE.md, *Continue till PR*). Rulings are at the end.
- **Date:** 2026-10-15
- **Source:** the one-pager `drafts/2026-10-15-request-logs-one-pager.md` (gitignored; restated
  below).
- **Builds on:** lanes (ADR 0006); prod on Lightsail, which keeps the container's stdout
  (ADR 0010); the server's one `Logger` (`apps/server/src/logger.ts`).
- **Touches:** a request-logging middleware on `/api/*`; `scripts/with-log.sh`, which the root
  `server` and `mobile` scripts now run through; `lane-env.sh` gains `LANE_LOGS`; `.gitignore`;
  CLAUDE.md.

---

## Goal

On 2026-10-15 a practice session on lane 0 stalled twice: two next-step requests never came back
to the app. Nothing recorded it. The server and Metro print to a terminal and nothing else, and
even that output would not have helped: the server logs events and errors, never a request. Prod
has the same gap: Lightsail keeps the log, but the log has no request in it.

**Done means:**

1. After a stall like that one, Claude can say from the saved files which request hung, when it
   arrived, and that it never finished, without Victor pasting anything.
2. It works on every lane, including after the server restarts itself on a code change.
3. In prod, the same per-request lines show up in the Lightsail log.

`npm test`, `npm run lint:arch` and the script tests pass.

## Scope

**In:**
- Every lane's server and Metro output saved to files Victor and Claude can read later.
- A line for every `/api` request when it arrives and when it finishes: method, path, headers,
  status, duration.
- The data bodies of requests and responses in those lines, in prod as well (Victor: "I have only
  a few friends testing the app now").
- Credentials masked.

**Out:** logs from the phone itself; media (photos, voice clips, any uploaded file); alerts,
dashboards, a log search page; any change to where prod keeps its logs or for how long.

**Open (Victor's):** bodies in prod are fine "now"; when they come out of prod is not decided.
D5's single switch is what makes that a one-line change.

## Design

### D1 — Two lines per request, joined by an id

A middleware registered first on `/api/*` in `app.ts` writes, through the existing
`Logger.info`:

```json
{"event":"request_started","req":"r17","method":"POST","path":"/api/sessions/08f5…/next-step","query":"","headers":{…}}
{"event":"request_body","req":"r17","body":{…}}
{"event":"request_finished","req":"r17","method":"POST","path":"/api/sessions/08f5…/next-step","status":200,"duration_ms":31204,"body":{…}}
```

A request that never finishes is a `request_started` with no `request_finished` for its `req`.
The started line is written the moment the request arrives and never waits for the body: the
body is read beside the handler and logged on its own `request_body` line once it has arrived,
so a slow upload is on record from its first byte (final review, re-graded).
That is the whole of done-means 1: a hung request stands out by what is missing, so nothing has
to time it out.

`req` is `r` plus a counter the middleware's closure holds, so it is short enough to grep and
needs no randomness. It restarts at `r1` when the process does; the timestamps in the file (D3)
and Lightsail's own tell two runs apart. The path is repeated on the finished line so either
line reads alone.

Only `/api/*`: `/health` is Lightsail's health check, every few seconds, and the web app's static
files and `/docs` are not the app talking to the server. A thrown error still gets its finished
line: Hono's `onError` has already turned it into the 500 that `next()` returns to the
middleware.

### D2 — Bodies: JSON data, media left out, credentials masked

A body is logged only when it is JSON (`content-type` contains `json`). Anything else is logged
as the string `<omitted: <content-type>, <n> bytes>`. A JSON body is read from a clone of the
request or response, so the handler, Better Auth included, still reads the original. Then:

- **Size.** A request body is read only when it declares a `content-length` of at most 256 KB.
  Over that it is `<omitted: <n> bytes>`; with none it is `<omitted: no content-length>`, since a
  chunked body could be any size and the log reads it before any route's own limit (final
  review). A response is the server's own JSON, sent without a length, so it is read and then
  held to the same 256 KB. A photo import is about 2.7 MB of base64 and is never even parsed for
  logging.
- **Media.** Any string over 2 000 characters becomes `<omitted: <n> chars>`. Base64 media is the
  only data this API carries in strings that long, so a voice clip under 256 KB is left out too.
- **Credentials.** Headers `cookie` and `authorization` (the session, and the bot route's and
  the reminder tick's bearer secrets) become `<masked>`. So does any JSON field, at any depth, whose name ends in `token`,
  `password`, `secret`, `otp` or `cookie`, any case. That covers Better Auth's `token`, the email
  code's `otp`, a push device's `token` and the bot sign-in's session `cookie`.

The rules live in a pure module (`apps/server/src/routes/requestLog.ts`, exported
`redactBody` and `redactHeaders`) that the tests reach without a server.

### D3 — Each lane writes its own files

`scripts/with-log.sh <name> <command…>` runs a command with its output shown as before and
also appended to `$LANE_LOGS/<name>.log`. Each line in the file starts with the local time to
the millisecond, so the JSON lines, which carry no time, are placed in time. ANSI colour codes
and carriage returns are stripped from the file, not from the terminal.

`LANE_LOGS` is derived by `lane-env.sh` as `<checkout>/.logs` (ADR 0006 R5: a new shared
resource comes from the lane, and a path inside the checkout is the lane's by construction).
`.logs/` is gitignored. It goes with the worktree when `lane:clean` or `lane:abandon` removes
it, so cleaning needs nothing new.

Root `package.json`:

```
"server": "bash scripts/lane-env.sh bash scripts/with-commit.sh bash scripts/with-log.sh server npm run dev --workspace apps/server",
"mobile": "bash scripts/lane-env.sh bash scripts/with-commit.sh bash scripts/with-log.sh --tty metro npm run start --workspace apps/mobile",
```

`tsx watch` restarts the server inside the wrapper, so a restart's output lands in the same
file (done-means 2). Each start of the wrapper writes a `---- <name> started <time> (<commit>)`
line.

### D4 — Metro keeps its terminal

Metro is interactive: its keys (`r` to reload, `a` for Android) and its QR code need a
terminal. A pipe would take that away. `--tty` runs the command under `script` (macOS:
`script -q /dev/null …`; Linux: `script -qfec "…" /dev/null`), which gives the command a
terminal of its own and passes keys through. `script`'s output then goes through the same
timestamping as the server's. When the wrapper's own stdin is not a terminal (a test, a
Claude shell), `--tty` is ignored.

Rotation: at start, a file over 50 MB is moved to `<name>.log.1`, replacing an older one. One
previous file is enough to look back past a restart; anything older is not what this is for.

### D5 — Prod

The middleware runs everywhere: prod writes the same JSON lines to stdout, which Lightsail keeps
(done-means 3). Bodies are on in every environment. `createRequestLog` takes `bodies: boolean`,
and `index.ts` passes `true`. Taking bodies out of prod later is that one argument, read from the
environment in `index.ts`.

## Testing

- `routes/requestLog.test.ts`: on a bare Hono app with a recording logger: a started and a
  finished line per request, sharing `req`; status and duration; a thrown error finishing as
  500; a handler that never resolves leaving only `request_started`; headers and JSON fields
  masked; a long string and an oversized body left out; a non-JSON body summarised; the handler
  still reading the body; `bodies: false` logging no body.
- `app.test.ts`: `/api/*` is logged, `/health` is not.
- `scripts/test-with-log.sh` (CI `check-adrs` job, beside `test-with-commit.sh`): output reaches
  the terminal unchanged and the file timestamped; stderr is captured; the exit code is the
  command's; ANSI codes are stripped from the file; the start line; rotation over the limit;
  `--tty` with no terminal runs the command plainly.
- `scripts/test-lane-env.sh`: `LANE_LOGS` for lane 0 and a worktree.

## Rulings (self-approved under "go till PR")

- **R1 — A wrapper, not the server writing its own file.** Only a wrapper also catches what is
  printed outside the logger: `tsx`'s compile errors, an uncaught exception's stack, Metro.
- **R2 — Counter ids, not UUIDs.** Short and greppable, and no randomness to inject (ADR 0002).
- **R3 — `/api/*` only.** `/health` every few seconds from Lightsail would drown everything.
- **R4 — Credentials masked (one-pager, assumed).** Anyone who can read the prod log could
  otherwise sign in as a tester.
- **R5 — No new ADR.** The middleware sits in `routes/` beside `actor.ts` and logs through the
  existing `Logger` (ADR 0001 R7 holds). The log directory is covered by ADR 0006 R5 as it is.
