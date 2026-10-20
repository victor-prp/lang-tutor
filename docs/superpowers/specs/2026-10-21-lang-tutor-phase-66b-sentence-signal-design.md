# Phase 66b — The sentence's own signal

- **Status:** Designed with Victor in chat on 2026-10-20/21, over two browser mockups. He said "go
  till PR" after the last playback (CLAUDE.md, *Continue till PR*). Lines marked **(Victor)** are
  his; **(my call)** lines are mine.
- **Date:** 2026-10-21
- **Builds on:** phase 66 (the word-only grade, the explainer, `answer_explanations`, הסבר).
- **Touches:** `POST /sessions/{id}/judged-answer` and its response; the translation card, its
  input and the feedback banner; integration, unit and e2e tests. No prompt changes.

---

## Goal

After phase 66 a translation whose practised word is right shows the green "נכון!" banner and the
learner's sentence in green, even when the sentence is full of mistakes. The only trace is a small
הסבר pill that looks the same whether the sentence has mistakes or not. Victor: "There's no good
indication the sentence is wrong."

**(Victor)** The card says two things: **word → correct, sentence → needs correction.** The grade
stays phase 66's: the word alone. Only what the card shows changes.

**Done means:**

1. A translation card answered with the word right and mistakes elsewhere shows, at the same moment
   as the grade: the banner lines "✓ המילה נכונה" and "! המשפט צריך תיקון", the learner's
   sentence in orange, and the corrected sentence under it.
2. A tap on הסבר shows each mistake (`wrong → right` and its reason); a second tap hides them.
3. `npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass. The evals are
   untouched, since no prompt changes.

## Non-goals

- Any change to grading, memory, readiness or the recompute **(Victor, phase 66)**.
- Any change to the judge's or the explainer's prompts, budgets or eval cases.
- The other cards.

**Anti-goal:** losing the grade to the sentence check. A failed or slow check never fails the
answer; the card then looks as it does today.

---

## D1. One request, two checks side by side

**(Victor)** One API call, and both the word and the sentence wait for it. **(my call, Victor
agreed)** The app sends one request; the server runs the judge and the explainer at the same time
and answers once both are done. They are **not** merged into one prompt. A merged prompt would put
the sentence's mistakes back in front of the word's grader, which is the rule phase 66 removed. It
would also make the two checks run one after the other, and mean re-proving the judge's eval set.

**Cost in time.** Recent local `model_calls`: `translation_judge` p50 2.3 s, p90 2.8 s;
`sentence_explain` about 3.2–3.5 s (phase 66 R2). So the wait goes from ~2.3 s to ~3.5 s. Both
clients keep the judge's timeout (`JUDGE_TIMEOUT_MS`, 8 s by default), and that is the cap: the
grade never waits longer than it already could for the judge.

`answerJudged` (`services/sessions.ts`), for a `sentence_translation` card only:

- **When it starts.** After the card checks and the wrong-alphabet gate, before the judge's call,
  so the two run together. Nothing is started for a replay, a desync or a wrong alphabet.
- **What it checks.** The text of this request, which is the first answer or the second try's
  text. An empty text (show the answer, a give-up) is not checked: `null`. Text that matches the
  reference as typed (`explainRuleResult`) has no mistakes and needs no call.
- **What the call does.** The phase 66 call, unchanged: `buildExplainPrompt`, `parseExplain`, kind
  `sentence_explain`. Any failure (timeout, unreadable answer, provider error) gives `null` and is
  logged `answer_explain_failed`. It never throws, so the judge's own path and its 502 are as
  before. If the judge fails, the check's result is dropped.
- **After `submitAnswer`.** If the recorded answer is now waiting for its second try (another
  accepted word), the result is dropped and the response says `null`. The second try's request
  checks the second text. Otherwise a result from the model is stored with
  `insertExplanation`/`findExplanation` (phase 66's first-stored-stands), and the stored one is
  returned. A rule result is returned and not stored, as in phase 66.
- **Replays.** A judged answer sent again returns the stored row. If no row is stored, it returns
  the rule result for the recorded final text, or `null`. It never makes a call. A card still
  waiting for its second try replays `null`, and so does an empty final text (show the answer, a
  give-up), as on its first send.
- **ADR 0001 R8.** The explanation row is a write that is **independent and idempotent**. The
  answer is correct whether or not it lands, and `ON CONFLICT DO NOTHING` makes repeating it a
  no-op. So it gets its own transaction after `submitAnswer`'s. If something fails between the
  two, the answer is still correct and has no explanation row; phase 66's `/explain` can still
  make one. No transaction is open while either model call runs.

**Wire.** `JudgedAnswerResponseSchema` gains
`explanation: ExplainResponseSchema.nullable().optional()`:

- **Absent** on a `typed_meaning` card.
- **`null`** on a translation card that wasn't checked (empty text, waiting for its second try)
  or whose check failed.
- **The explanation** otherwise. No mistakes means the sentence is right.

The route description says so. No `API_LEVEL` bump, because the field is additive. An older app
ignores it and keeps calling `/explain`, which stays as it is and now usually finds the row
already stored. A newer app talking to an older server gets no field and shows today's card.

**Logs.** `answer_explained` / `answer_explain_failed` as in phase 66, with `explain_ms`, from
the judged route. **(my call)** `answer_judged` keeps its fields. How long the request took as a
whole is already in `request_finished`.

Bots answer the translations they get right with the reference, so most of those cost no call.
Each wrong one now costs one explain call more. **(my call)** That's accepted; nothing gates it.

## D2. The card

The approved mockup (`.superpowers/brainstorm/…/sentence-signal-v2.html` in the main checkout,
frames 2 and 3). Frame 1, the grey "בודק את המשפט…" moment, belonged to the two-request version
that D1 replaced, and is not built.

**The banner** (`FeedbackBanner`), on a translation card whose answer came with an explanation:

- **Line 1, the word.** The title as today, colored by its tone. For `exact` the title becomes
  "המילה נכונה" instead of "נכון!". It gets an icon when its tone is correct (✓, green) or wrong
  (✗, red). Near miss, another word, helped and still-another-word keep their titles and lines.
- **Line 2, the sentence.** It shows either:
  - with no mistakes: "✓ המשפט נכון" in green;
  - otherwise: "! המשפט צריך תיקון" in amber text (`amberText`, `amber` icon) and a **הסבר**
    pill at its end, which toggles the details.
- **With no explanation** (`null` or absent), the banner is exactly today's.

**The input.** If the word is wrong, the border is red as today. Otherwise, if the sentence has
mistakes, it's orange (`amber` border, `amberSurface` fill). Otherwise it's as today.
**(my call)** That also covers a helped answer and another accepted word: a sentence with
mistakes is orange whenever the word isn't wrong.

**Under the input**, when the sentence has mistakes: the corrected sentence in one line, left to
right. Its words that differ from the learner's are green and bold, found by a word-level
longest-common-subsequence match **(my call)**, with tokens compared after `normaliseTyped`. It
has no reasons and no label. The mockup marks it with a ✓.

**The details**, open only after a tap on הסבר, sit under the corrected sentence. They hold one row
per mistake: `wrong` struck through in red, `→`, `right` in green, and `why` under it, right to
left. Phase 66's R4 U+200F lead on the reason stays. A second tap closes them. Opening them
scrolls the screen to the end, because the banner covers the bottom of the screen. Moving to the
next card closes them.

**What goes away:** `SentenceExplain`, the phase 66 pill under the reference, the app's call to
`/explain` (`api.explainAnswer`), and the strings only they used (`explainCorrected`,
`explainNone`, `explainLoading`, `explainFailed`). The reference block stays as it is.

**State.** The explanation lives in the session hook's state beside the answer, set when the
answer lands (`landed`) and cleared on every new card (`applyQueued`). Whether the details are open
is screen state, held by question id, so a new card starts closed. The banner and the card read
both.

**Strings** (Hebrew, `strings.ts`): `feedbackWordCorrect` "המילה נכונה", `sentenceRight`
"המשפט נכון", `sentenceNeedsFix` "המשפט צריך תיקון". `explainButton` "הסבר" and `explainWhy`
stay.

## Tests

- **Integration** (`tests/integration/routes/`), each through the route with MockServer:
  - A model-judged translation returns the stubbed explanation and stores one row.
  - The reference as typed returns no mistakes and makes no explain call.
  - Show the answer returns `null`.
  - A failing explain stub still returns the grade, with `null` and nothing stored.
  - Another accepted word returns `null` while waiting, then the second try returns its own
    explanation.
  - A replay returns the stored row and makes no call.
  - A `typed_meaning` card has no field.
- **Unit (server):** `answerJudged`'s new branches, with fakes: the explainer and the judge both
  run, a failed explainer leaves the verdict, and a pending answer drops the result.
- **Unit (app):**
  - What the banner's second line shows for each case: right, needs fixing, none.
  - The input's border rule.
  - The corrected sentence's changed words.
  - The state being cleared on the next card.
- **e2e** (`sentence-cards.spec.ts`): the translate card answered with a mistake shows both
  banner lines, the orange input and the corrected sentence. הסבר opens the mistake and closes
  it again. The default explain stub (no mistakes) means every other spec's translation card now
  shows "המשפט נכון" and the title "המילה נכונה"; specs that check a translation's
  `feedback-title` are updated to match.

## Left to the builder

Names inside the app, the diff helper's tokenising, the icons' drawing, and how the banner's two
lines are laid out within the mockup.

## Rulings made while building
