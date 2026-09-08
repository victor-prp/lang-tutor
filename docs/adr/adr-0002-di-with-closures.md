# ADR 0002: Dependency injection via closures, constructed only at a composition root

- **Status:** Accepted
- **Date:** 2026-09-06
- **Source:** [phase 4 design](../superpowers/specs/2026-08-30-lang-tutor-phase-4-postgres-design.md),
  *"Closure-based dependency injection is mandatory"*, and
  [phase 5 design](../superpowers/specs/2026-09-05-lang-tutor-phase-5-di-corrections-design.md),
  which corrected the eight places that rule was not yet followed.

## Decision

Every collaborator with I/O, state, or a lifecycle — a database handle, an HTTP client, a
clock, a source of randomness, storage — is *received*, never reached for. One rule, no
opt-out, across `apps/server/src` and `apps/mobile/src`:

```
composition root        names concrete things: new Pool, Math.random,
(index.ts, db/cli.ts,   AsyncStorage, Crypto.randomUUID, process.env
 _layout.tsx)
      │  passes values, not imports, downward
      ▼
createX(deps)           a factory: returns an object of closures,
                        no module-level state, no jest.mock needed
      │
      ▼
consumer                names what it needs in its parameters;
                        type is ReturnType<typeof createX>
```

A composition root is the one place naming a concrete implementation is the point. Every
other file receives what it needs as a parameter and stays swappable for a test's fake.

## Rules

| # | Subject | Must not appear outside a composition root |
|---|---|---|
| R1 | Concrete I/O/randomness implementations | `Math.random` (server); `@react-native-async-storage/async-storage`, `expo-crypto` imports (mobile) |
| R2 | `process.env` | any read of `process.env`, in either app |
| R3 | Module-level exported singletons | `export const x = createX(...)` / `export const x = new X(...)` at module scope |
| R4 | `jest.mock` | anywhere in `apps/server` or `apps/mobile` |
| R5 | Defaulted or optional collaborator parameters | `rng`, `onError`, `randomUUID`, `logger`, `storage`, `fetch` declared `?:` or given a default value |

Composition roots: `apps/server/src/index.ts`, `apps/server/src/db/cli.ts`,
`apps/mobile/src/app/_layout.tsx`. `apps/server/src/config.ts` is not a composition root —
`loadConfig(env)` takes the environment as a parameter, so it names no concrete thing.

## Rules that are not import rules

- **R6 — A factory returns an object of closures; its type is `ReturnType<typeof createX>`,
  never hand-written.** Not greppable: a hand-written type that structurally matches a
  factory's return shape still satisfies `tsc` at every call site, so a regex can't
  distinguish "derived" from "coincidentally identical." Enforced by review; the list of
  factories (`createDb`, `createConsoleLogger`, `createSessionRepo`, `createQuestionRepo`,
  `createHealthRepo`, `createUserRepo`, `createTransaction`, `createSessionService`,
  `createUserService`, `createGeminiClient`, `createTranslationService`, `createServerDeps`,
  `createApiClient`, `createRememberedUsernameStore`) is short enough to spot-check.
  `createGeminiClient` is annotated at its call site in `composition.ts` rather than at its
  definition, because ADR 0001 R10 forbids `providers/` from importing the contract it
  satisfies — the same arrangement as `createTransaction` and `Transaction`.
- **R7 — Importing a composition root performs no I/O.** `apps/server/src/index.ts` guards
  its construction behind `require.main === module`, so `main()` runs only when the file is
  executed directly. Enforced by `apps/server/src/index.test.ts`, which imports the module
  and asserts nothing opened. `_layout.tsx` is exempt: it is a UI entry point Expo Router
  renders, constructed once per app launch, not imported by a test the way `index.ts` is.

## How to detect a violation

`npm run lint:arch` runs these alongside ADR 0001's; `scripts/check-adr-0002-di-with-closures.sh`
mirrors this block verbatim. Each command must print nothing.

```bash
# R1 — concrete I/O/randomness implementations named only at a composition root
grep -rn "Math\.random" apps/server/src --include='*.ts' | grep -v -e '/index\.ts:' -e '\.test\.ts:'
grep -rln "from '@react-native-async-storage/async-storage'\|from 'expo-crypto'" apps/mobile/src --include='*.ts' --include='*.tsx' | grep -v '_layout\.tsx'

# R2 — process.env read only at a composition root
grep -rn "process\.env" apps/server/src apps/mobile/src --include='*.ts' --include='*.tsx' \
  | grep -vE ':[0-9]+:[[:space:]]*(//|\*)' \
  | grep -v -e '/index\.ts:' -e '/db/cli\.ts:' -e '_layout\.tsx:'

# R3 — no module-level exported singleton
grep -rnE "^export const [a-zA-Z_]+ = (create[A-Z]|new [A-Z])" apps/server/src apps/mobile/src --include='*.ts' --include='*.tsx' | grep -v '\.test\.ts:'

# R4 — no jest.mock
grep -rn "jest\.mock(" apps/server apps/mobile --include='*.ts' --include='*.tsx'

# R5 — no optional or defaulted collaborator parameter
grep -rnE "\b(rng|onError|randomUUID|logger|storage|fetch)\?\s*:" apps/server/src apps/mobile/src --include='*.ts' --include='*.tsx' | grep -v '\.test\.ts:'
grep -rnE "(rng|onError|randomUUID|logger|storage|fetch)\s*=\s*[^,}]+[,}]" apps/server/src apps/mobile/src --include='*.ts' --include='*.tsx' \
  | grep -v '\.test\.ts:' | grep -vE ':[0-9]+:[[:space:]]*(//|\*)'
```

### What the rules cover

- Scans `apps/server/src` and `apps/mobile/src`, including their co-located `*.test.ts` /
  `*.test.tsx` files, except where a specific command excludes a test file because a fake
  legitimately constructs a concrete stand-in there.
- `apps/server/tests/` is out of scope, matching ADR 0001's precedent: `tests/support/` is
  the test composition root and may reach anywhere; the rest of `tests/integration/` is
  governed by ADR 0001, not this one.
- Composition roots (`index.ts`, `db/cli.ts`, `_layout.tsx`) are exempted from R1-R3 by
  name, since naming a concrete thing is what they exist to do.
- `config.ts` is deliberately not exempted from R2: `loadConfig` takes `env` as a parameter,
  so a `process.env` read appearing there would itself be the violation.
- R4 and R5 have no exemptions: no file in either app's `src/` needs `jest.mock`, and no
  collaborator parameter is allowed a default anywhere in scope.

## Why

- A defaulted collaborator (`rng = Math.random`, `onError?`) reopens the seam it was added
  to close: the reach-out simply moves to whichever caller relies on the default, one layer
  outside where the rule can see it. Phase 5 records this happening once already — commit
  `422075e` removed a defaulted `rng` from `newSessionRecord`, and the reach-out moved
  straight to its only caller.
- A module-level exported singleton (`export const db = …`) gives every test in a worker one
  shared connection to one database, making a per-test cloned database unreachable — the same
  failure mode `db/client.ts`'s own comment names for why `createDb` returns a value instead.
- `jest.mock` is a symptom, not a tool: `jest.spyOn(console, 'log')` in the pre-phase-5
  `services/sessions.test.ts` was exactly this signal, and it also mutated process-global
  state across a Jest worker.

## Related

- [ADR 0001](adr-0001-layered-architecture.md) governs *which layer may import what*; this
  ADR governs *how a collaborator is constructed and passed*, an orthogonal axis. ADR 0001's
  R5-R6 (app.ts/composition.ts) and R7 (console) are the layering half of the same wiring
  this ADR completes.
- README's *Architecture* section states this rule in prose for a human reader; this ADR is
  its enforced form.
