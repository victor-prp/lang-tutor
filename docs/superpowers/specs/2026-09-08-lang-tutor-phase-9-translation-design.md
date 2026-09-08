# Phase 9 — Translating a word, phrase or sentence

- **Status:** Approved, ready for an implementation plan
- **Date:** 2026-09-08
- **Source:** `docs/superpowers/drafts/adding-words-to-student.md`

## Summary

A learner types a word, a phrase or a sentence and gets its meanings back, most common
first — a word or a phrase with an example sentence in both languages, a sentence with just
its translation. A **more** button reveals the remaining meanings; pressing the button on
the one that fits confirms the choice. The server asks Gemini for the translation and
returns every option in one response.

This phase is about the experience, not about storage. It reads nothing from the
vocabulary tables and writes nothing to them. It is also the first time this server makes
an outbound call to a third party, holds a secret, or depends on a non-deterministic
answer — which is where most of the design below goes.

## What this adds

| Area | Addition |
|---|---|
| Wire | `POST /api/translations` — one endpoint, no persistence |
| Server | `providers/` — a new layer for outbound third-party I/O |
| Server | `services/llm.ts` — a two-line provider abstraction |
| Server | `domain/translation.ts` — direction detection, prompt building, parsing. Pure |
| Mobile | `app/translate.tsx` and an entry point on the home screen |
| Tests | A fourth bucket: prompt evals against the real model |
| Tests | A MockServer compose service standing in for Gemini, driven per test |
| Docs | ADR 0001 gains R10/R11 for `providers/` and an amended R8; ADR 0004 R4 gains the eval bucket. No new ADR |

No table is created, altered or dropped. There is no migration in this phase.

## Decisions settled during design

**Nothing is persisted, and the confirmation says otherwise on purpose.** Pressing the
button shows `התרגום נשמר לאוצר המילים שלך` — "the translation is saved to your
vocabulary" — while this phase saves nothing. This was raised as a problem and decided
deliberately: the play-test is meant to measure the real experience, and the phase that
keeps the promise comes next. **The consequence must be carried into how the play-test is
read.** A tester saying the flow felt satisfying is evidence about the interaction and
about the wording; it is *not* evidence that saving works, because saving does not exist.
Any tester question about where their words went is expected, not a bug report. No
vocabulary screen exists in this phase, so nothing in the app contradicts the message.

**Direction is detected by script, not by the model.** Hebrew and Latin occupy disjoint
Unicode ranges, so `/[\u0590-\u05FF]/` answers "which way round is this" deterministically,
for free, and in a unit test. Asking the model would have made the app's most basic
behaviour non-reproducible and billable. The detected direction is echoed in the response
and shown on screen with a `⇄ החלף` control, so a wrong guess is visible and correctable
rather than silently wrong; the control re-requests with an explicit `direction`.

**One call carries every sense.** The response holds up to five ranked senses and
**more** is a client-side reveal. A second request would add a spinner, a second failure
mode, and latency to a button whose entire job is to feel instant. It also means the
ranking the model produced cannot change between the first and second look.

**No senses is a success, not a failure.** Gibberish gets `200` with `senses: []` and the
app says `לא מצאנו תרגום`. "I have no translation for this" is a correct answer about the
input; a 4xx or 5xx would say the request or the server was broken, and would put an
ordinary outcome on the same footing as the provider being down.

**`kind` is classified by the model, with one deterministic override.** Whether the input
is a `word`, a `phrase` or a `sentence` cannot be decided by counting tokens: `break a
leg` is three tokens and a phrase, `I read` is two and a sentence, and learners do not
type terminal punctuation. The model answers it in the same structured response, at a cost
of a few output tokens. The one case that *is* certain is decided in code:
`domain/translation.ts` forces `kind` to `word` when the trimmed input contains no
internal whitespace, whatever the model said.

**A sentence withholds the save confirmation.** Sentences are still translated and shown,
but the per-meaning button does not offer to save one, and **more** is hidden because a
sentence has one translation rather than competing senses. The reason is not tidiness: it
is already decided that a sentence does not belong in a vocabulary as-is, so claiming a
save there would train testers to expect the one behaviour known not to be coming. What
to *do* with sentences is the next phase's question; refusing to lie about them is this
phase's answer.

**`LlmClient` is the provider abstraction, and it is a JSON completion call rather than a
translation call.** The seam is drawn one level *below* the feature: a provider is asked for
a JSON-shaped completion, not for the meanings of a word, so the prompt, the response
schema, the parsing and the ranking live once in `domain/`. Had the seam been `Translator`
— "give me senses for this word" — each provider would carry its own copy of the prompt,
which is both the thing that will actually be tuned and the thing that must be *identical*
across providers for a comparison between them to mean anything.

Two words in this spec are easy to conflate, so they are used precisely: the **provider
abstraction** is the type `LlmClient`, declared in `services/llm.ts`; the **provider layer**
is the folder `providers/`, governed by ADR 0001 R10 and R11. The first is the contract,
the second is the address.

**No `LLM_PROVIDER` switch.** With one provider it is a branch with one arm. The
composition root names `createGeminiClient` directly; the branch arrives with the second
provider, and the point of the seam is that nothing else moves when it does.

**Raw `fetch`, not `@google/genai`.** The SDK reads `GEMINI_API_KEY` from the environment
itself, which ADR 0002 R2 forbids outside a composition root. A single JSON POST does not
justify importing a client that breaks the repo's one non-negotiable wiring rule.

## Wire contract

One endpoint, declared as a `createRoute` definition backed by Zod schemas in
`packages/core/src/api/schemas.ts`, per ADR 0003.

| Endpoint | Request | Responses |
|---|---|---|
| `POST /api/translations` | `{ text, direction? }` | `200` + `Translation` · `400` invalid · `502` provider unavailable |

```
TranslationRequestSchema  = { text: string 1..100,
                              direction?: 'en_he' | 'he_en' }   // omitted = detect

TranslationSenseSchema    = { translation: string,
                              part_of_speech?: string,          // absent for a sentence
                              example?: { source: string, target: string } }

TranslationKindSchema     = 'word' | 'phrase' | 'sentence'

TranslationResponseSchema = { text: string,                     // normalized echo
                              direction: 'en_he' | 'he_en',     // what the server decided
                              kind: TranslationKind,
                              senses: TranslationSense[] }      // ranked, 0..5

// What the model is asked to return. The server adds `text` and `direction`,
// which it already knows and must not let the model contradict.
LlmTranslationSchema      = { kind: TranslationKind,
                              senses: TranslationSense[] }
```

**`part_of_speech` and `example` are optional, and a sentence has neither.** A part of
speech classifies a lexical item, and *"I'm looking forward to seeing you"* is not one. An
example sentence is redundant when the input already *is* a sentence — the translation is
the whole answer, so an example would restate it. Both fields are therefore absent when
`kind` is `sentence`, the prompt says so explicitly, and the card omits the rows rather
than rendering empty ones. Making them optional in the schema rather than empty strings is
what keeps "no part of speech" distinguishable from "the model forgot".

**`LlmTranslationSchema` is what the model is asked to satisfy.** It is the response schema
minus `text` and `direction`: both are decided in code before the call is made, so including
them would invite the model to disagree with the server about which direction it was
translating. It travels to the provider **as a Zod schema**, not as a JSON Schema document —
each provider converts it to its own dialect, for reasons measured in *The LLM abstraction*
below.

**`part_of_speech` is a plain string on the wire, not an enum.** This follows the
precedent `UserSchema` already sets for the language fields: narrowing a *response* field
turns a value the model produces tomorrow into a validation failure inside clients that
shipped today. The app maps the values it recognises to Hebrew through `strings.ts` and
omits the line for anything it does not, so an unfamiliar part of speech degrades to a
missing label rather than a broken screen.

**The example sentence is given in both languages.** The example is what separates סֵפֶר
from לְהַזמִין, and the learner is asking precisely because they cannot read the source
language — so a disambiguator written only in that language does not disambiguate. This
costs roughly 30px of card height, which is what decides whether the remaining senses fit
on screen once **more** is tapped.

`direction` is a request field and a response field with different meanings: absent on the
way in means "detect", while on the way out it is always concrete. The `⇄ החלף` control is
the only thing that sends it explicitly.

Every type stays a `z.infer` (ADR 0003 R3), `api/index.ts` still exports types only (R4),
and the router supplies the `defaultHook` that keeps the failure body
`{ error: 'invalid request' }` (R7).

## Server layers

Following ADR 0001's shape, with one new layer:

```
routes/translations.ts    createTranslationsRouter(translations: TranslationService)
                          transport only — parse, validate, map outcome to status
services/translations.ts  createTranslationService({ llm, logger })
                          build → call → parse → log. No transaction: no table is touched
services/llm.ts           type LlmClient, LlmJsonRequest — types only
domain/translation.ts     detectDirection, buildRequest, parseSenses, overrideKind. Pure
providers/gemini.ts       createGeminiClient({ fetch, baseUrl, apiKey, model })
errors.ts                 + LlmUnavailable, TranslationUnreadable
composition.ts            builds the client from io, injects it into the service
```

**Why `providers/` is a new layer rather than a new repository.** ADR 0001's table was
written when the only I/O was Postgres. `repo/` means Drizzle and `pg` (R4), and a
repository is handed a `Tx` it composes inside a transaction — a Gemini client has no
transaction to join and no SQL to write. Filing an HTTP client under `repo/` would make
R4's own detection commands meaningless, since they exist to keep Drizzle *in* that
folder. `providers/` is the layer for outbound third-party I/O, sits at the same depth as
`repo/`, and is imported only by `composition.ts`. ADR 0001's new R10 and R11 record this.

**This is the first use case with no transaction at all**, which makes ADR 0001 R8's
wording false as written: "each use case is exactly one `transaction(...)` call" — this
one has zero. R8's grep only detects *excess* calls, so nothing would have flagged it and
the prose would have quietly stopped describing the code. R8 is amended to read *a use
case that touches the database is exactly one `transaction(...)` call*. See **ADR
consequences**.

`services/translations.ts` imports its collaborators as types and never names Gemini, a
URL, or `fetch`, so R2 holds unchanged: the service layer still cannot reach transport or
persistence, and now cannot reach a provider either.

## The LLM abstraction

The entire seam, in `services/llm.ts`:

```ts
import type { ZodType } from 'zod';

export type LlmJsonRequest = { system: string; user: string; schema: ZodType };
export type LlmClient = (request: LlmJsonRequest) => Promise<string>;
```

Types only, exactly as `services/transaction.ts` holds `Transaction` — which is what keeps
a provider's name out of the service layer without an interface file or a base class.

Where it sits, and who may see what:

```
routes/translations.ts        transport
  services/translations.ts    orchestration
    domain/translation.ts     prompt · schema · parse · rank    ▲ above: shared
    ═════ LlmClient ═════     the provider abstraction
    providers/gemini.ts       HTTP envelope only                ▼ below: swappable

composition.ts                the only file that imports providers/
```

**A service depends on the contract, not on a provider reached through it.**
`services/translations.ts` never imports `providers/` — not even as a type, since the type
is declared locally in `services/llm.ts`. It therefore never learns that a provider exists:
the same service, unmodified, is satisfied by a fake `LlmClient` in its unit test, by
`createGeminiClient` in production, and by an in-process model later. This is stricter than
ADR 0001 R2's treatment of `repo/`, which does permit a type-only import — here the folder
is invisible above the composition root entirely.

That is the same shape ADR 0002 already imposes on the database: `services/` holds
`Transaction`, `composition.ts` binds the real repositories into it, and no service can name
Drizzle. `LlmClient` applies the pattern to outbound HTTP, which is why the rule should read
as familiar rather than new.

**It returns the raw JSON text, not a parsed object.** Parsing and validation then happen
once, in `domain/translation.ts`, so a model that returns malformed output fails
identically whoever served it. A provider's whole job becomes: shape a request, extract one
text field, and map its own failures to `LlmUnavailable`.

### `schema` carries the Zod schema, not a JSON Schema document

This is the one field where the seam's placement is load-bearing, and an earlier draft got
it wrong by typing it `object`. `object` says nothing — it admits `{}`, `[]`, a function —
but the real problem is that a *JSON Schema document* cannot be provider-neutral.

Measured, not assumed. `z.toJSONSchema` over the sense shape (zod resolves to **4.5.4**
here, not the `^4.4.3` in `package.json`) emits:

```json
{ "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": { "kind": { "type": "string", "enum": ["word","phrase","sentence"] },
                  "senses": { "type": "array", "maxItems": 5, "items": {
                      "properties": { "translation": {}, "part_of_speech": {}, "example": {} },
                      "required": ["translation"],
                      "additionalProperties": false }}},
  "required": ["kind","senses"],
  "additionalProperties": false }
```

Usefully, it **inlines** the sense shape — no `$ref`/`$defs`, which Gemini rejects — and
`maxItems` survives. But the last two keys are where portability dies:

| Emitted | Gemini `responseSchema` | OpenAI strict `json_schema` |
|---|---|---|
| `$schema` | not in its Schema type — strip | strip |
| `additionalProperties: false` | not in its Schema type — **strip** | **required on every object** — keep |
| optionals omitted from `required` | correct: omission means optional | **illegal** — all properties must be required; optional is `type: ["string","null"]` |

The two providers want **opposite things about the same key**, and they disagree precisely
about the fields this design deliberately made optional. So a JSON Schema document in the
request can satisfy at most one provider — and whoever produced it has already chosen a
dialect. That producer would be `domain/`, which is the purest layer in the server: dialect
knowledge would have leaked upward, past the seam built to contain it.

Typing the field `ZodType` fixes this at the root. `domain/` hands over its own contract in
its own language and makes no dialect decision; each provider converts on arrival:

- `providers/gemini.ts` → `toGeminiSchema()`: `z.toJSONSchema`, then drop `$schema` and
  `additionalProperties`.
- `providers/openai.ts`, later → `toOpenAiStrictSchema()`: keep `additionalProperties`, and
  promote every optional into `required` as a nullable type.

Each is a small pure function with its own unit test, living in the only layer permitted to
be provider-specific. Zod is the neutral form here by construction: under ADR 0003 it is
already this repo's schema language and the source of truth for the whole wire contract, so
it predates every provider and each one converts *from* it.

Two consequences, decided here rather than discovered during implementation:

- **`parseSenses` must treat `null` and absent identically** (`.optional().nullable()` on
  the parse side). Under OpenAI strict, `part_of_speech` returns as `null` rather than
  missing; a parser tolerating only absence would break on the provider swap — the exact
  coupling this seam exists to prevent.
- **A provider now holds the schema, and must still not validate with it.** Parsing stays in
  `domain/`. The temptation is created by this very change, so it is worth naming as a rule
  rather than trusting to taste.

The Gemini and OpenAI columns above are from knowledge, not verified this session — the
structured-output docs page timed out. The conclusion does not depend on the details: Zod
expresses optional by omission from `required` and OpenAI strict forbids that, so at least
one provider needs a transformation regardless. The plan carries confirming the exact
supported key lists, alongside confirming the model id.

**Adding OpenAI later** therefore means one new file implementing `LlmClient` — its request
shape, `choices[0].message.content`, and its own `toOpenAiStrictSchema` — plus one changed
line in `index.ts`. Nothing in `domain/`, `services/`, `routes/` or the existing tests
moves.

What the abstraction deliberately does **not** cover: streaming, tool calls, multi-turn
conversations, embeddings, and token accounting. One JSON-shaped completion is the only
capability this application has ever needed, and a seam wide enough for capabilities
nobody uses is a seam nobody can change.

### Gemini specifics

Verified against the current API reference rather than from memory:

- `POST {baseUrl}/v1beta/models/{model}:generateContent`
- The key travels in an **`x-goog-api-key` header**, never as a `?key=` query parameter — a
  query parameter puts the secret into URLs, access logs and any intermediary proxy.
- Structured output via `generationConfig.responseMimeType: 'application/json'` plus
  `generationConfig.responseSchema`, with `temperature: 0`. The schema sent there is
  `toGeminiSchema(request.schema)`, not `z.toJSONSchema`'s output verbatim — see
  *`schema` carries the Zod schema* above.
- The answer is at `candidates[0].content.parts[0].text`.
- A safety block arrives as `promptFeedback.blockReason` with no candidate, and maps to an
  empty sense list rather than an error — the input was refused, the server was not broken.

The model id is a configuration value with **no hardcoded default in application code**.
Public sources disagreed about which Gemini Flash generation is current, and writing a
guess into a spec would be worse than naming the uncertainty: the implementation plan
carries a step to confirm the exact id against the live model list before wiring it.

## The prompt

`buildRequest` is a pure function in `domain/translation.ts`, so the prompt is an artifact
under version control and under test rather than a string buried in a client.

The `system` part carries the instruction: translate between Hebrew and English for a
Hebrew-speaking learner of English; return senses ranked with the most common first; cap at
five; give each sense a part of speech and one short natural example sentence in the source
language together with its translation; **omit both for a sentence**, which gets one sense
carrying the translation alone; classify the input as `word`, `phrase` or `sentence`;
return an empty sense list rather than inventing a translation for something that is not a
word or expression in either language.

The `user` part carries **only the learner's text**, kept separate from the instruction.

Three rules in the prompt exist because of specific failure modes:

- **A fixed dictionary expression is a `phrase` even when it is grammatically imperative.**
  Without this, `break a leg` classifies as a sentence, since it is an imperative clause —
  and the learner is asking about the expression, not its grammar.
- **An idiom is translated by meaning, not word by word.** `break a leg` must not come
  back as לשבור רגל. This is the single highest-value assertion in the eval set.
- **A sentence returns exactly one sense.** Senses are competing meanings of a lexical
  item; a sentence has a translation, and padding it into a list of alternatives would put
  filler behind a **more** button that should not appear at all.

**The learner's text is untrusted input that reaches a model.** It is capped at 100
characters, passed as the `user` part rather than concatenated into the instruction, and —
the protection that actually matters — constrained by structured output, so a prompt
injection cannot change the *shape* of what the client parses. The worst case is a strange
string rendered as text; the app renders no markup from this response. The API key never
appears in a log line, and neither does a full model response except truncated on a parse
failure.

## Mobile app

One new screen, one new entry point, no change to identity or session code.

| Route | Behaviour |
|---|---|
| `app/index.tsx` | Home gains a card that navigates to `/translate`. The `futureSpace` View this screen already reserves is where it goes. |
| `app/translate.tsx` | The whole flow: a text field, the answer, **more**, and the per-sense button. |

`api/client.ts` gains `translate`. It is a POST, so the existing `postJson` helper covers
it and no `getJson` is needed — the same reason phase 8 needed none. `strings.ts` gains the
Hebrew copy for every state below.

### Screen states

| State | What is on screen |
|---|---|
| Idle | The field and a submit control. Nothing else. |
| Loading | A skeleton card where the answer will appear. |
| Answered | The detected direction with `⇄ החלף`, the top sense as a card with its own button, and `עוד משמעויות (n)` when `n > 0`. |
| Revealed | The remaining senses, each an identical card with its own button. |
| Chosen | The chosen sense alone, marked, with `התרגום נשמר לאוצר המילים שלך` and `מלה חדשה`. |
| Empty | `לא מצאנו תרגום` and the field kept as typed, so it can be corrected rather than retyped. |
| Error | `התרגום לא זמין` and a retry control. |

For `kind: 'sentence'` the **more** control and the per-sense button are both absent: one
translation, and no offer to save it. The Chosen state is therefore unreachable for a
sentence, which is the intended behaviour and needs a test that says so.

### Details that would otherwise be discovered late

- **This field must not be forced LTR.** Phase 8 pins `writingDirection: 'ltr'` on the
  username input because a username is lowercase ASCII. This field takes either script, so
  it follows its content instead. Copying the username field's treatment would put the
  caret on the wrong side for every Hebrew lookup.
- **No lookup as the learner types.** Submission is explicit. Debounced as-you-type
  translation would bill a request per keystroke.
- **No streaming.** A structured JSON response cannot be rendered partially, so the honest
  treatment of the one-to-three second wait is a skeleton, not a progressively filling
  card.
- **`more` reveals, it does not navigate.** The revealed senses are the same list on the
  same screen; there is no second route and no second request.
- **A sense card's own button is what selects it**, not the card body. The learner is
  reading these cards to compare them, and a tap-anywhere card turns reading into
  accidental choosing.

## Errors

| Condition | Server | Learner sees |
|---|---|---|
| Provider 5xx, network failure, or timeout | `502` `{ error: 'translation unavailable' }` | `התרגום לא זמין` + retry |
| Provider `429` | `502`, with its own log line | the same |
| Model returned unparseable or schema-invalid JSON | `502`, raw text truncated in the log | the same |
| Model returned nothing, or a safety block | `200` `senses: []` | `לא מצאנו תרגום` |
| `text` empty, blank, or over 100 characters | `400` `{ error: 'invalid request' }` | inline field error |

The provider call carries a ten-second budget through an `AbortController`. **There is no
retry and no backoff:** a learner who taps retry *is* the retry, and it keeps a failure
legible instead of turning one slow answer into three sequential ten-second waits. A
distinct log line per cause is what makes the single client-visible failure diagnosable
from the server side.

`TranslationUnreadable` and `LlmUnavailable` are separate errors that map to the same
status deliberately: the learner can do nothing different about either, while the operator
needs to know whether the provider failed or the prompt did.

## Configuration and secrets

`Config` gains three fields, read in `loadConfig(env)` — still a pure function of its
argument, so it remains not a composition root.

| Variable | Default | Notes |
|---|---|---|
| `GEMINI_API_KEY` | **none — `loadConfig` throws** | The secret. Never logged. |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com` | Pointed at a MockServer namespace by every test bucket. |
| `GEMINI_MODEL` | none in code; supplied by environment | Confirmed against the live API during implementation. |

**A missing key fails at startup, not at the moment a learner taps the button.** This is
the same reasoning phase 8 used to drop the `native_language` and `target_language`
defaults: a default can only mask a bug. The cost is real and worth naming — `npm run
server` now needs a value in the environment, so `scripts/setup-worktree.sh`, the
SessionStart hook's advice and the README all gain a line, and a developer working only on
sessions must still supply something. Pointing `GEMINI_BASE_URL` at local MockServer with any
dummy key is the answer for local work.

**There is no fake code path inside the server.** The only thing that differs between a
test run and production is a URL, so a misconfiguration is a wrong host — loud, and
visible in a log — rather than a branch that quietly serves invented Hebrew. This is why
the design has no `LLM_PROVIDER=stub` mode: an environment variable that switches on a
fabricated answer is exactly the kind of apparatus phase 8 removed from the identity flow.

`createServerDeps(io)` gains `fetch` and the Gemini settings, and builds the client itself
— assembly, which is what that file is for. `index.ts` remains the only place that names
`globalThis.fetch` and reads the environment.

## Testing

Placement follows ADR 0004 — the folder decides the bucket — and this phase adds a fourth
bucket. **Integration and e2e treat the server as a black box: no fake is injected into it
at any point.** What varies for them is `GEMINI_BASE_URL`, nothing else.

### Unit (`src/**/*.test.ts`, Docker stopped)

| File | Covers |
|---|---|
| `apps/server/src/domain/translation.test.ts` | Direction detection either way and on mixed input; the single-token `kind` override; prompt shape; parsing; schema-invalid and non-JSON model output; the five-sense cap. All pure — this file carries most of the phase's logic. |
| `apps/server/src/providers/gemini.test.ts` | Request shape, the `x-goog-api-key` header, extraction from `candidates[0]`, a safety block, and mapping every failure to `LlmUnavailable`. Plus `toGeminiSchema`: `$schema` and `additionalProperties` are stripped, `maxItems` and partial `required` survive. |
| `apps/server/src/services/translations.test.ts` | Orchestration against a fake `LlmClient` from `tests/support/fakes.ts` — the only support import R3 permits. |
| `packages/core/src/api/schemas.test.ts` | `text` bounds, the `direction` and `kind` enums, and that a `sentence` sense parses with `part_of_speech` and `example` both absent **and** both `null`. |
| `apps/mobile/src/api/client.test.ts` | The new call, extended. |

`providers/gemini.test.ts` passes a fake `fetch` to the client. That is a unit test of an
HTTP client — the collaborator ADR 0002 requires it to receive — and not a mock injected
into a running server; the distinction is what keeps the black-box rule below meaningful.
A unit test must not open a listener.

### Integration (`tests/integration/**`, mirroring the `src/` path)

The real `createServerDeps` and `createApp`, with `geminiBaseUrl` pointed at this test's own
namespace on the shared MockServer. Real route, real service, real domain, real provider,
real socket — the test starts nothing and injects nothing into the server.

Each test registers its expectations in `beforeEach`, clears them in `afterEach`, and
derives its namespace from a uuid so parallel Jest workers cannot collide. This mirrors what
the database side already does: `globalSetup` gives each worker a template, each test clones
its own database, and now each test owns its own mock namespace too.

| File | Covers |
|---|---|
| `routes/translations.test.ts` | `200` for a word, a phrase and a sentence; `senses: []`; `400` and its `{ error: 'invalid request' }` body (ADR 0003 R7); `502` for an expectation returning 500, one delayed past the timeout, and one returning unreadable JSON. Plus a MockServer `verify` that the request carried `x-goog-api-key`. |
| `services/translations.test.ts` | The use case against a real client pointed at MockServer, including that no transaction is opened. |
| `openapi.test.ts` | **extended:** the new endpoint and its three statuses appear in the published document. |
| `composition.test.ts` | **extended:** `createServerDeps` now takes `fetch` and the Gemini settings and returns a `translations` service. |

Two existing files change because `AppDeps` gains a field, and both are worth naming
because neither is a translation test:

- `tests/support/fakes.ts` — `createFakeAppDeps` lists every collaborator explicitly so a
  document-shape test fails loudly on the one it should never reach. It gains a
  `translations` entry whose methods throw, and a `createFakeLlmClient` for the service
  unit test.
- `src/app.test.ts` — constructs an app from fake deps; it compiles against the new shape
  without asserting anything new.

### The provider stand-in — MockServer as a compose service

**One shared MockServer container serves every bucket and every checkout.** It joins
`docker-compose.yml` beside Postgres, on its default port **1080**, and each test tells it
what to return before driving the flow:

```
1. PUT  localhost:1080/mockserver/expectation
        when  POST /<ns>/v1beta/models/{model}:generateContent  with body matching "book"
        then  200 { candidates: [ { content: { parts: [ { text: "{...}" } ] } } ] }

2. run the flow with  GEMINI_BASE_URL = http://localhost:1080/<ns>
```

`<ns>` is a per-test namespace, and it must be **per test rather than per checkout**:
`/worktree-a` alone would collide between parallel Jest workers inside one checkout. A uuid
per test is enough, and integration gets it free because each test already builds its own
`createServerDeps`. Each test clears its own expectations afterwards, so a long-lived shared
container does not accumulate them run after run.

**Why a shared instance is safe here, when an earlier draft said it wasn't.** That draft
specified a first-party mock deriving its answer from the requested text — behaviour
compiled into the server. A shared container would then have run *whichever checkout
started it* for everyone: worktree A expecting three senses for `book` while the container
ran worktree B's two-sense version, failing in a way that reads like a code bug, and no URL
prefix could fix it because a URL selects arguments, not which function body is running.

MockServer removes that failure mode at the root, and the reason is exactly why Postgres is
safely shared: **the container is a generic engine holding no repo-specific behaviour, and
each run pushes its own behaviour in at runtime.** `globalSetup` runs *its* migrations into
*its* database; a test registers *its* expectations under *its* namespace. Sharing needs
both halves — a namespace and runtime-supplied behaviour — and a pinned third-party image
supplies the second by construction, since there is no first-party code inside it to skew.

**Failure paths become expectations rather than reserved inputs.** The `__unavailable`,
`__slow`, `__unreadable` and `__empty` magic strings are gone: a `502` is an expectation
returning 500, the ten-second timeout is a response `delay`, unreadable output is an
expectation returning `not json`, and a dropped connection is MockServer's `error` action.
That is strictly better than magic inputs — the failure is declared in the test that cares
about it instead of encoded in a string the mock has to know about.

**Request verification replaces the header trick.** An earlier draft had the mock return
`401` when `x-goog-api-key` was missing, to prove the client sends it. MockServer's verify
endpoint does this directly: assert the request arrived with the expected header, so a
regression that drops it fails integration rather than passing everything but a unit test.

Two consequences of the shared instance:

- **A Gemini-envelope helper is needed** — `geminiResponse({ kind, senses })` in
  `tests/support/` and `e2e/tests/support/` — so a test declares senses rather than
  hand-writing `candidates[0].content.parts[0].text`. It is repo code, but it runs in the
  *test*, so it cannot skew.
- **`npm run test:integration` and `npm run e2e` gain a prerequisite.** Both already require
  `npm run db:up`; the compose service means the same command now brings up MockServer too.
  Unreachability must produce the same kind of clear message `globalSetup` already gives for
  Postgres — *"MockServer unreachable at …, run `npm run db:up`"* — not a driver stack trace.

The image tag is pinned and confirmed during implementation, alongside the model id. The
`clear` and `verify` endpoint paths are likewise confirmed then: `PUT
/mockserver/expectation` and port 1080 were verified during design, the rest were not.

### e2e

**No new `webServer` entry** — MockServer is a compose service, already running, so
Playwright starts nothing extra. The existing server entry's `env` gains
`GEMINI_BASE_URL: http://localhost:1080/e2e` and a dummy `GEMINI_API_KEY`. The namespace is
fixed for the run rather than per test, because the server is one long-lived process with
one environment; specs share it and each clears its own expectations, which is safe given
Playwright already runs `workers: 1` with `fullyParallel: false`.

Each spec registers its expectations through Playwright's `request` fixture before driving
the UI — the pattern phase 8 established for creating its learner via `POST /api/users`, so
no new machinery. `globalSetup.ts` gains a MockServer reachability check beside its Postgres
one. New `translate.spec.ts`:

- A word → the top sense → **more** → choose → the confirmation.
- A sentence → one translation, **no** `more` control and **no** save button.
- An empty sense list → `לא מצאנו תרגום`.
- An expectation returning `500` → the error state, and a retry that succeeds once a good
  expectation replaces it. Testing the retry *working* is the point; a permanently failing
  mock would only prove the error state renders.

`session.spec.ts` and `onboarding.spec.ts` are untouched.

### Prompt evals (`tests/eval/**/*.eval.ts`, opt-in, real model)

The fourth bucket, and the only code in the repo that calls Gemini for real. It exists
because every bucket above proves the plumbing and none of them can tell whether the model
puts the common sense first.

**It is a signal, never a gate.** A model update can turn it red with no change to this
repository, so it does not run on pull requests and is not a required check. Treating it as
a gate would make an external vendor's release schedule able to block a merge.

**It exercises the real artifact.** The runner calls
`createTranslationService({ llm: createGeminiClient(...) })` — the same prompt builder, the
same parser, the same provider as production, with only the base URL differing from a
normal run. It deliberately does not go through HTTP: the object under test is the prompt,
and booting a server and a database would add nothing to the loop around it.

**A standalone `tsx` runner, not a Jest project.** `tests/eval/run.ts`, invoked by `npm run
eval`. A third Jest project would sit one `--selectProjects` mistake away from being swept
into CI, and pass/fail per case is the wrong output shape — what a prompt change needs is a
scorecard. Standalone makes accidental inclusion structurally impossible and is why these
files are named `*.eval.ts` rather than `*.test.ts`.

**Two tiers, because "correct" and "good" are different questions.**

- **Tier 1 — invariants, 100% required.** The response parses against the schema; at most
  five senses; at least one unless the case expects none; `translation` contains Hebrew
  script for `en_he`. For a `word` or a `phrase`: `part_of_speech` is present,
  `example.source` contains the queried term or an inflection of it, and `example.target`
  is non-empty. For a `sentence`: exactly one sense, and **neither** `part_of_speech` nor
  `example` present. A Tier 1 failure is a real prompt bug.
- **Tier 2 — judgment, scored against a ≥85% threshold.** Is the top sense within the
  case's accepted set? Are the expected additional senses present anywhere in the list? Is
  `kind` right? Cases carry **accepted answer sets**, not exact strings, so a rewording does
  not fail them. Every case prints its actual output, so a drop is diagnosable rather than
  merely red.

**The golden set** — `tests/eval/cases.ts`, roughly twelve hand-curated cases, each
stressing one property:

| Case | Property |
|---|---|
| `book`, `bank` | Ranking: the common sense first, the rarer one still present |
| `light` | Senses spanning parts of speech (אור / קל) |
| `break a leg` | An idiom translated by meaning, and classified `phrase` despite being imperative |
| `running` | An inflected form still resolves |
| `מזלג` | The reverse direction, and that script detection agreed |
| `I'm looking forward to seeing you` | Classified `sentence`, and exactly one sense |
| `cool` | Register — slang against temperature |
| `asdkjhasd` | An empty sense list instead of an invented translation |

**Nondeterminism, handled rather than wished away.** `temperature: 0`, per-case output
printed, and a suite-level threshold for Tier 2 instead of per-case hard failure. Each run
writes a gitignored JSON report to `tests/eval/.results/`, so a prompt change is diffed
against the previous run rather than judged from memory.

**Cost and secrets.** Twelve cases, one call each, on demand — cents per run, with
`usageMetadata` token counts printed. If `GEMINI_API_KEY` is absent the runner **exits
nonzero with a clear message** rather than skipping quietly: a green "0 cases ran" is the
one outcome worse than a red suite. CI wiring is `workflow_dispatch` plus an optional
nightly cron, never on forks, with the key as a secret used by that job alone.

**No LLM-as-judge.** It is the usual next step, and it would allow asserting whether the
Hebrew reads naturally — but it doubles cost and adds a second nondeterministic component
to every verdict. Accepted-answer sets cover the questions this phase actually has. Worth
revisiting if Tier 2 proves too blunt.

## ADR consequences

**No new ADR.** Two existing ones are amended and no `create-adr` invocation is needed.
That is a reversal of this design's first draft, which proposed an ADR 0006 for outbound
providers, and the reasoning is worth recording because the reversal is the interesting
part.

### Why this is not a new ADR

ADR 0001's own header records the precedent: *"R2/R8 revised 2026-09-06 when the
transaction seam landed."* The last time a new seam appeared in this server it was absorbed
into ADR 0001 in place. `providers/` is the same kind of event.

Decomposing the five rules a separate ADR would have carried, three of them are not new:

| Rule | Home |
|---|---|
| Outbound I/O lives only in `providers/` | **ADR 0001** — a layer rule; needs a diagram row |
| `providers/` has one importer; consumers depend on a contract in `services/` | **ADR 0001** — structurally identical to R2/R8's `db/` → `Transaction` treatment |
| A provider maps its failures into `errors.ts` | **ADR 0001** — the same flavour as R9, a rule that is not an import rule |
| A provider receives `fetch`, a URL, a key and a model, and reads no environment | **already ADR 0002** R1/R2/R5 — needs only `createGeminiClient` on R6's factory list |
| `domain/` stays pure, no `fetch` there | **already ADR 0001 R3** — needs nothing |

A separate ADR would therefore have been two genuinely new rules wrapped in three
restatements, and it would have split "which layer may import what" across two documents —
exactly the drift ADR 0003 R2 forbids for the wire contract, which has one home for the
same reason.

ADR 0005 is the counter-precedent and it does not apply here: it earned its own document
because it constrained code that did not yet exist against a temptation no existing ADR
mentioned. `providers/` is not like that. A reader asking who may import whom already knows
to open ADR 0001, and that is where the answer belongs.

### ADR 0001 — amended: R8, plus two rules for `providers/`

The layer diagram gains `providers/` beside `repo/`, and the rule table gains two entries.
They are **appended as R10 and R11 rather than renumbered**, because the existing numbers
are cited by `scripts/check-adr-0001-layered-architecture.sh`, the README and three earlier
specs.

| # | Layer | May import | Must not import |
|---|---|---|---|
| R10 | `providers/` | `fetch`, its own transport types, `errors`, `logger` | `routes/`, `services/`, `domain/`, `repo/`, `db/`, `app.ts`, `composition.ts` |
| R11 | `providers/` | — | **anything, from anywhere except `composition.ts`** — every consumer depends on a contract type declared in `services/` (`LlmClient` is the first), and only the composition root knows which provider satisfies it |

**R8 is amended.** It currently reads "each use case is exactly one `transaction(...)`
call". This phase adds a use case with **zero**, because it touches no table. R8's detection
command greps for *excess* `.transaction(` call sites, so nothing would have flagged the
mismatch and the ADR's prose would have quietly stopped describing the code. Amended
wording: *a use case **that touches the database** is exactly one `transaction(...)` call.*
No detection command changes.

**One new rule that is not an import rule.** A provider maps every failure of its own into
`errors.ts`; a provider-specific error shape must not escape the layer. Not greppable — the
absence of a leaked type is invisible to a regex — so it sits alongside R9, enforced by
review.

The header's date line gains a second revision note, exactly as the transaction seam got
one.

Both new rules are greppable, and the two commands go into the **existing**
`scripts/check-adr-0001-layered-architecture.sh`, taking it from fifteen checks to
seventeen:

```bash
# no outbound HTTP outside providers/
grep -rnE "\bfetch\(|generativelanguage|api\.openai\.com" \
  apps/server/src --include='*.ts' --exclude-dir=providers \
  | grep -vE "^[^:]*(index\.ts|\.test\.ts):"

# providers are constructed only at the composition root
grep -rnE "(from|require\(|import\()[[:space:]]*'[^']*providers/" \
  apps/server/src apps/server/tests --include='*.ts' --exclude-dir=providers \
  | grep -vE "^[^:]*(composition\.ts|tests/support/|tests/eval/)"
```

Three things about the second command are deliberate, and each replaces a version that
was wrong:

- **The directory is skipped with `--exclude-dir`, not with `grep -v '/providers/'`.** An
  earlier draft filtered the *line content*, and every violation's import path contains
  `/providers/` — so the exclusion deleted precisely the lines the check was hunting, and
  the command could never report anything. All the remaining `-v` filters are anchored to
  the path with `^[^:]*` for the same reason.
- **It matches `require(` and `import(` as well as `from`,** so a dynamic import or a
  `require` cannot launder the dependency. A barrel that re-exports a provider is caught at
  the re-export itself, since `export … from '…providers/…'` matches too.
- **It scans `apps/server/tests` as well as `src`,** exempting only `tests/support/` — the
  test composition root, per ADR 0001 and ADR 0004's precedent. Without this, an integration
  test could construct a Gemini client directly and be black-box in name only. There is no
  blanket `*.test.ts` exemption: a service's unit test has a fake `LlmClient` and has no
  business importing a provider, while `providers/gemini.test.ts` is already covered by
  `--exclude-dir`.
- **`tests/eval/` is exempt alongside `tests/support/`**, because it is a second test
  composition root and naming `createGeminiClient` is the whole point of it — the eval bucket
  is the only code in the repo that calls the real provider.

It also does **not** exempt `services/`. An earlier draft did, by analogy with ADR 0001
R2's type-only allowance for `repo/` — but the analogy does not hold, because a service
needs no import from `providers/` at all when its contract lives in `services/`. Exempting
the folder would have whitelisted the precise thing the rule exists to catch: a service
reaching for a collaborator instead of receiving one, which is also an ADR 0002 violation.

### ADR 0004 R4 — amended

R4 forbids a `*.test.ts` anywhere under `apps/server/tests/` outside `tests/integration/`.
Naming the eval files `*.eval.ts` passes R4's existing `find` untouched — but a third
bucket that merely slips past a grep is exactly the kind of unrecorded arrangement ADR 0004
exists to prevent. R4 gains an explicit clause naming `tests/eval/` as the opt-in real-model
bucket, plus two new rules:

```bash
# an eval file is never picked up by a Jest project
grep -rn "eval" apps/server/jest.config.js

# nothing under tests/eval/ is imported by src/
grep -rn "tests/eval" apps/server/src --include='*.ts'
```

### The check discipline — deliberately not an ADR

**Every check added to a `scripts/check-adr-*.sh` must be shown to fail on a planted
violation before it is trusted.** The R11 command above shipped in an earlier draft of this
spec in a form that could never report anything, and it passed a "run it, it prints nothing"
review — because a vacuous check and a satisfied one are indistinguishable by that test.
`check-adrs.sh` is this repo's enforcement backbone, and an inert check inside it is worse
than a missing one, because it reads as coverage.

This is a rule about process, not about code structure, so it belongs in neither ADR. It
goes in `check-adrs.sh`'s header comment — beside the discovery convention already
documented there — and as a line in `CLAUDE.md`. The implementation plan carries it as an
explicit step for R10 and R11: plant a violation, confirm the script reports it, remove it.

Worth noting and **out of scope**: the five existing check scripts have never been verified
this way either. A pass over them is real work with its own risk of finding more inert
commands, and it is not phase 9's job.

## Documents this phase adds and edits

| Document | Change |
|---|---|
| `docs/adr/adr-0001-layered-architecture.md` | **R10 and R11** for `providers/`, R8's wording, a `providers/` row in the layer diagram and table, the new non-import rule beside R9, and a second revision note in the header |
| `scripts/check-adr-0001-layered-architecture.sh` | The two verified commands for R10 and R11 — fifteen checks becomes seventeen |
| `docs/adr/adr-0002-di-with-closures.md` | R6's factory list gains `createGeminiClient`, `createTranslationService` |
| `docs/adr/adr-0004-test-topology.md` | R4's third-bucket clause and its two new checks |
| `scripts/check-adr-0004-test-topology.sh` | The two new R4 commands |
| `scripts/check-adrs.sh` | Header comment: a new check must be shown to fail on a planted violation |
| `README.md` | The phase index, the architecture section's layer table, and the new environment variables |
| `README.md`, *Reading the API* | The open API now spends money when called: `POST /api/translations` reaches a paid third party with no rate limit in front of it |
| `scripts/setup-worktree.sh` | Report a missing `GEMINI_API_KEY` the way it already reports a missing `.env.local` |
| `CLAUDE.md` | A line on the eval bucket (opt-in, real model, never in CI) and one on the planted-violation rule |
| `docker-compose.yml` | **new service** — MockServer on 1080, pinned tag, with a healthcheck so `--wait` blocks until it accepts connections |
| `package.json` | `db:up` brings up MockServer alongside Postgres, so the integration and e2e prerequisite stays one command |
| `e2e/globalSetup.ts` | A MockServer reachability check beside the Postgres one, with the same style of actionable error |

**No file is created in `docs/adr/`, and no new `check-adr-*.sh` is added.** Both new rules
land in the ADR that already governs layering, and in the script that already enforces it.

## Out of scope

Named so they are not mistaken for oversights:

- **Reading or writing the vocabulary tables.** No lookup of saved words, and nothing
  saved. `vocab_terms`, `vocab_term_senses` and `term_sense_translations` are untouched,
  despite already modelling this shape almost exactly.
- **What to do with a sentence.** This phase detects one and declines to offer a save. The
  next phase decides what a sentence becomes.
- **Caching repeat lookups.** The same word asked twice costs twice. A cache needs an
  invalidation story and a place to live, and this phase has neither.
- **Lookup history.** Nothing records what was asked.
- **Rate limiting and cost caps.** Nothing stops a learner — or anyone with the URL — from
  firing off lookups in a loop. See *Risks*.
- **Audio, transliteration and nikud** beyond whatever the model returns inside the
  translation string.
- **Streaming responses.**
- **A third language.** `direction` has two values.
- **An `LLM_PROVIDER` switch and a second provider.** The seam exists; the branch does not.
- **LLM-as-judge in the evals.**

## Risks

- **The model id is unconfirmed.** Public sources disagreed about the current Gemini Flash
  generation. Config-valued, with a plan step to verify against the live model list.
- **`responseSchema`'s exact supported key list is unconfirmed.** The docs page timed out
  during design, so `toGeminiSchema`'s strip list comes from knowledge rather than
  measurement. Wrong in either direction is cheap to detect — a rejected schema is a `400`
  on the first real call — and the plan verifies it before the eval bucket runs.
- **"Most common sense first" is a model-quality property no test can assert.** The eval
  set scores it against accepted answers; the play-test is what actually validates it.
- **Every lookup costs money and nothing caps it.** The endpoint is unauthenticated, like
  every other endpoint here (ADR 0005), but it is the first one whose abuse has a bill
  attached. Acceptable for a play-test on a local network; it must not reach a public host
  in this state.
- **The save confirmation is untrue in this phase.** Accepted deliberately; the reading of
  the play-test has to account for it.
- **Latency is the experience.** One to three seconds is the difference between a tool and
  a chore, and it is largely outside this repository's control. The skeleton state is the
  only mitigation here.

## Success criteria

1. A learner types an English word in the app and sees its most common Hebrew meaning with
   a bilingual example, then reveals the rest with **more** and picks one — with no
   `curl`, no database access, and no restart.
2. A Hebrew word, typed into the same field with no toggle touched, comes back in English,
   and `⇄ החלף` recovers from a wrong detection.
3. A sentence is classified as one, shows one translation, and offers neither **more** nor
   a save.
4. Gibberish shows `לא מצאנו תרגום`, and a dead provider shows `התרגום לא זמין` with a
   retry that works.
5. `npm run test:all` and `npm run e2e` are green with **no network access and no API
   key**, because every bucket points at the MockServer container.
6. No fake, stub or `__DEV__` branch exists inside `apps/server/src`: the only difference
   between a test run and production is `GEMINI_BASE_URL`.
7. `npm run eval` scores the real model against the golden set and prints a per-case
   scorecard; it is absent from every CI job that runs on a pull request.
8. `npm run lint:arch` passes and reports **seventeen** ADR 0001 rules rather than fifteen
   — **and R10 and R11 have each been demonstrated to fail on a planted violation**, so "it
   printed nothing" is evidence of compliance rather than of an inert command. No file was
   added to `docs/adr/` and no new `check-adr-*.sh` exists.
9. Switching provider is demonstrably one file: `services/translations.ts`, `domain/` and
   every test above compile and pass without edits when `createGeminiClient` is replaced.
