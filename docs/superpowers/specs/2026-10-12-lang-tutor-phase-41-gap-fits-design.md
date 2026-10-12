# Phase 41 — A fill-in sentence that points to its word, and a word that fits is never wrong

- **Status:** Victor reported the bug on 2026-10-12, asked for both fixes as one small phase, named
  it phase 41 and said "go till PR": the design is self-approved (CLAUDE.md, *Continue till PR*).
  Rulings are at the end.
- **Date:** 2026-10-12
- **Builds on:** phase 38 (the typed fill-in card hides its Hebrew; D2's list of words that fit
  the sentence read alone, and its switch signal: "Victor finds fitting words marked wrong"),
  phase 34 D9 (one second try after a right answer that is not the saved word), phase 27 D3
  (the judge client, called outside any transaction).
- **Touches:** the `sentence` task's prompt line; one optional request field; one judge prompt
  and its parser; the next-step route and `submitAnswer`; `step`'s options; the app's answer
  route for a typed fill-in. No migration, no new secret, no `API_LEVEL` change.

---

## The bug

Lane 0, question `bd18d546…` (`cloze_typed`, en for a Hebrew speaker), Hebrew hidden
(`hint_opened = false`):

| | |
|---|---|
| sentence | *Please download the file.*, gap `download` |
| alternatives | `upload, open, save, delete, send, share, get, fetch, retrieve, acquire` |
| first answer | `upload` → `alternative`, the second try opened |
| retry | `edit` → `wrong` |

`edit` fills *Please ___ the file.* as well as `upload` does, but the model left it out of the
list, and the card is judged by `judgeTyped` against that list alone. Two causes:

1. **The sentence is open.** *Please ___ the file* takes dozens of verbs; with the Hebrew hidden
   nothing in it points to `download`. Ten listed words cannot cover it, and the list spends slots
   on synonyms (`fetch`, `retrieve`, `acquire`) while missing common fits.
2. **Nothing judges an unlisted word.** Phase 38 D2 chose the list alone and named the signal for
   adding a judge. The signal has fired.

## Goal

**Done means:**

1. *Please ___ the file.* answered `edit` is right, says "it fits, but we meant…", opens the Hebrew
   and gets the second try, as `upload` does.
2. New fill-in sentences point to their word: read alone, the word, or one of the same meaning, is
   among the likeliest fills.

`npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e` and `npm run eval` pass, and
`TIER2_THRESHOLD` is not lowered.

## Scope

**In:** the `sentence` task's prompt (D1); a model check of an unlisted first answer on a
`cloze_typed` card (D2); the app waiting for it (D3).

**Out:** a judged retry (R3); writing a judged fit back into the card's list (R4); every other
card type.

---

## 1. Decisions

### D1. The sentence points to its word

The `sentence` task's line in `buildDistractorPrompt` gains one clause, before the alternatives:
the sentence's other words must point to this word, so that someone reading it without its
translation and without the word would guess it, or a word of the same meaning; never a sentence
that many different words would complete, such as *Please ___ the file.* The alternatives stay as
phase 38 has them: every other word that fits the sentence read alone, at most 10, judged on the
phone with no wait.

### D2. An unlisted first answer is checked by the model

**Request.** The `text` form of `NextStepRequestSchema` gains `check_fit: boolean`, optional. The
app sends it on a first answer to a `cloze_typed` card whose rule verdict is `wrong` and whose text
is not empty (D3).

**When the server calls.** `submitAnswer`'s caller, the next-step route, goes through a new service
method, `answerText`, for a `text` request with `check_fit: true`. It calls the judge only when all
hold, checked in a read transaction first, as `answerJudged` checks (ADR 0001 R8):

- the attempt is a first `answer` (not a retry, replay or desync);
- the card is `cloze_typed`;
- the text is not empty, passes the wrong-alphabet gate, and `judgeTyped` calls it `wrong`.

Anything else goes straight to `submitAnswer`, exactly as today. So a listed word, a slip of the
saved word, an empty text or a replay never costs a call.

**The call.** The judge client of phase 27 (thinking off, its own timeout). The prompt carries the
`JUDGE_MARKER`, says the learner saw the sentence with a gap and no translation, and asks one
thing: does `answer`, put in the gap, make a correct and natural sentence, whatever it then means?
It is told the word meant and that the form must fit the gap (`downloads` in *Please ___ the file*
does not). The schema is `{ verdict: 'fits' | 'wrong' }`.

**The verdict.** `fits` is recorded as `alternative` through the path a listed word takes: `step`
takes a `fits: true` option, and evaluates that one answer with the card's alternatives widened by
the typed text. The hold, its notice (phase 38 D3), the hint opening and the score are then all
phase 34's and phase 38's, unchanged. `wrong` is recorded as the rule had it.

**A failure** (timeout, refusal, unreadable verdict) records the rule's `wrong` and logs
`answer_fit_check_failed` with `judge_ms` and the reason. A call that answered logs
`answer_fit_checked` with its verdict and `judge_ms`.

**Replay.** A resent answer is a `replay` attempt, so it is never judged twice; its stored verdict
is the response.

### D3. The app waits for the check

`answerRoute` in `apps/mobile/src/quiz.ts` sends to the `server` route a first answer to a
`cloze_typed` card that `evaluate` calls `wrong` with a non-empty text, as it already sends one
that opens a retry. The card locks while checking and offers "try again" on a failed request,
both phase 34's. `nextStepRequest` adds `check_fit: true` to that answer only. A response that holds
the card opens the second try with phase 38's notice; any other lands as the wrong answer it is.
A second try stays on the `banner` route (R3).

`mayOpen` counts such an answer as one that may open the hold its response carries, as it counts a
judged text. Without that, `metHold` would read the server's hold as one a lost earlier answer
opened and resend this text as the second try.

### D4. Compatibility

`check_fit` is optional: an older app never sends it, the server never calls the judge for it, and
it is graded as today. No response changes. `API_LEVEL` stays at 3 (ADR 0012: only a required
request field, a removed field or a changed meaning raises it).

## 2. Changes

- `packages/core/src/api/schemas.ts`: `check_fit` on the text request; `LlmFitJudgeSchema`.
- `apps/server/src/domain/distractors.ts`: D1's clause.
- `apps/server/src/domain/judge.ts`: `buildFitJudgePrompt`, `parseFitJudge`.
- `apps/server/src/domain/session.ts`: `step`'s `fits` option.
- `apps/server/src/services/sessions.ts`: `answerText` (check, call, record through
  `submitAnswer`); `submitAnswer` passes `fits` to `step`.
- `apps/server/src/routes/sessions.ts`: the next-step route reads `check_fit` and calls
  `answerText`; its description names the field.
- `apps/mobile/src/quiz.ts` (`answerRoute`, `nextStepRequest`) and `hooks/useSession.tsx`.
- MockServer stubs (`apps/server/tests/support` and `e2e/tests/support`): `expectJudge` takes
  `fits` as a verdict. The fit prompt carries `JUDGE_MARKER`, so the existing stub answers it.

## 3. Testing

- **Unit (core):** the request schema takes `check_fit` and refuses a non-boolean.
- **Unit (server):** the sentence prompt carries D1's clause; the fit prompt names the sentence,
  the gap, the word meant and the answer, and never the translation; `parseFitJudge` reads both
  verdicts and refuses anything else; `step` with `fits` records `alternative` and holds the card,
  and ignores `fits` on a retry.
- **Unit (mobile):** `answerRoute` sends a wrong non-empty first `cloze_typed` answer to the
  server, and not an empty one, a listed word, a retry, or a wrong answer on another card;
  `nextStepRequest` sets `check_fit` only there.
- **Integration:** fit `fits` stores `alternative` with `retry_state = 'pending'`; `wrong` stores
  `wrong`; a judge failure stores `wrong`; no `check_fit` and a listed word make no call; a replay
  makes no second call.
- **E2E** (`sentence-cards.spec.ts`): a typed fill-in answered with an unlisted word the fit stub
  accepts shows phase 38's retry notice with the Hebrew open.
- **Eval:**
  - fit-judge cases, tier 2, each `fits` or `wrong`: *Please ___ the file.* with `edit` and
    `upload` (fits), `downloads` and `banana` (wrong); and a few in Italian and Russian, where
    gender and case decide (`una nuova ___` takes `casa`, not `fiore`);
  - a sentence tier 2 check: shown the sentence with its gap and no translation, the judge
    client's three likeliest fills include the word or one of its accepted answers;
  - phase 38's "lists at least one other word that fits" stays.

## 4. Rulings

- **R1.** The check runs only when the app asked and is waiting, so an older app never meets a
  hold its banner did not expect, and no level is raised.
- **R2.** A failed check is `wrong`, not "try again": the card stays answerable with the model
  down, and the miss costs what it cost before this phase.
- **R3.** First answers only. A retry's verdict never moves memory (`evidenceVerdict` reads it only
  when it is right), and its banner is the first answer's either way, so a check there buys a wait
  and a call for nothing the learner sees.
- **R4.** A judged fit is not written into the card's list: questions are one session's, and a
  replay returns the stored verdict.
- **R5.** D1 and D2 together: D1 makes a fit-check rare, D2 covers what D1 and the list miss.
