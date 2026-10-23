# Phase 74 — Words for me with choices

- **Status:** Victor scoped this in a one-pager and mocks on 2026-10-24 and answered its open
  questions one by one. He then said "go till PR" (CLAUDE.md, *Continue till PR*), so the design
  is self-approved. Lines marked **(Victor)** are his; **(my call)** lines are mine.
- **Date:** 2026-10-24
- **Source:** `drafts/2026-10-24-words-for-me-choices-one-pager.md` (main checkout); mocks at
  https://claude.ai/artifact/X7Yxp9F94edPzBbhYVt4X3 (before D8 dropped לסיום).
- **Builds on:** phase 69 (Words for me: profile, rounds, lookups; spec
  `2026-10-21-lang-tutor-phase-69-words-for-me-design.md`), phase 73 (no words → Words for me →
  a session), phase 70 (the new-word settings screen), phase 43 (stock).
- **Touches:**
  - **server:** the discovery domain, service, routes and repo; the stock trigger; the current
    read's `new_count`; the new-word limits.
  - **data and wire:** migration 0052; the wire contract, with `API_LEVEL` 7.
  - **app:** the Words for me screen, a new end screen, the home action and the new-words
    settings screen.
  - **tests and eval:** the `discover ` eval group, and the unit, integration and e2e tests.

---

## Goal

**(Victor)** A learner who knows a word often can't recall the exact Hebrew word, so typing the
meaning counts a word they know as unknown. Each card becomes a multiple-choice question, and the
learner decides on each card whether the word joins My words. The first run should go straight to
the words and end ready to practise, which Victor called "very important for the first impression".

**Done means:**

1. **(Victor)** Unit tests.
2. **(my call)** The usual suites pass: `npm test`, `npm run test:all`, `npm run lint:arch`,
   `npm run e2e`, and the eval group `discover ` twice.

## Non-goals

- Typing a meaning on a Words for me card. The meaning judge leaves this flow.
- The cards of practice sessions; the two level questions.
- Measuring whether the words fit the level or are useful. The eval checks shape (as phase 69).
- Replacing a session already waiting in stock **(Victor: "no need to replace waiting session")**.

**Anti-goals (my call):**
- A learner kept from practising the words they already have.
- A card that waits on a lookup.
- A wrong option that is really a right meaning.

## Decisions

### D1. A card **(Victor)**

The word in its white card, then five rows in one column:
- the four Hebrew meanings, in an order shuffled when the round is written;
- "אין לי מושג" as the fifth row, not a separate button. The counter above reads "נוספו {n} מתוך
  {goal} מילים".

After any pick the right meaning turns green with a ✓, and the other rows are disabled:
- a wrong pick turns red with a ✕;
- a picked "אין לי מושג" turns blue (OptionButton's `selected`);
- the rest are dimmed.

The wire card carries the choices and which one is right, so the app colours the rows with no round
trip **(my call)**.

### D2. Add or don't add **(Victor)**

Under the rows: להוסיף and לא להוסיף side by side. The app's suggestion is the solid button and the
other is pale:
- after a right pick it suggests **לא להוסיף**;
- after a wrong pick or "אין לי מושג" it suggests **להוסיף**.

Tapping the suggestion records the card and moves to the next card at once; there is no הבא.

Tapping the other choice opens a bottom sheet. It shows the word large, its meaning under it, and an
explanation. It then offers both choices, the learner's own first (pale) and the suggestion second
(solid); either one records the card and moves on.

| Case | Bold line | Second line | Buttons |
|---|---|---|---|
| right, tapped להוסיף | נראה שאתם כבר מכירים את המילה הזאת. | בכל זאת להוסיף אותה, כדי לתרגל אותה בהמשך? | להוסיף · **לא להוסיף** |
| wrong or no idea, tapped לא להוסיף | נראה שהמילה הזאת חדשה לכם. | מומלץ להוסיף מילים שאתם לא מכירים, כדי לתרגל אותן ולזכור אותן. | לא להוסיף · **להוסיף** |

**One request per card (my call):**
- **The request:** `POST /discovery/runs/{id}/cards/{position}/answer` with
  `{ pick: 0–3 | null, add: boolean }`; `null` is "אין לי מושג".
- **What it records:** the pick, whether it was right, the choice, and the suggestion the learner
  saw.
- **The response:** `{ run }`.
- **A second answer** to a card already answered changes nothing and answers the run (the first
  stands, as phase 69).
- **A pick out of range** gets a 400.

### D3. The level **(Victor: "right and not added")**

A card counts as known for the level when its pick was right and the word was not added. `known`
is written with the answer. Phase 69's `levelAfter` bands and its four-card minimum stay.

### D4. A round's prompt

`buildDiscoveryPrompt` gains three rules. `LlmDiscoverySchema` gains `wrong: string[]` per item,
required, as every field is (memory: optional strings hang calls).

- **Wrong meanings (Victor: the same request):**
  - What the prompt asks:
    - three Hebrew meanings that are plainly not meanings of the item;
    - each a meaning of another word of the same part of speech, or another Hebrew phrase for a
      phrase;
    - no niqqud, and about as long as `hebrew`.
  - What `parseDiscovery` drops:
    - a wrong meaning that is empty, over-long or not in Hebrew script;
    - one equal to `hebrew` or an alternative (`normaliseHebrew`, as `meaningRuleVerdict`
      compares);
    - one equal to another wrong meaning.
  - It keeps the first three. A word left with fewer than three is dropped, and counted in
    `dropped`.
- **Useful words (Victor):** prefer items people use often in everyday speech and writing at
  that level; no rare, archaic, literary-only or narrowly technical words.
- **Phrases from B2 (Victor: level 7 and up, about 3 in 10):**
  - At level ≥ 7, rule 1 becomes: about 4 of the 14 items are multi-word expressions a dictionary
    lists as one entry (idioms, fixed expressions, verb phrases), and the rest single words.
  - Asking for 4 of 14 leaves about 3 in a round of 10 after the drops.
  - Below level 7, rule 1 stays as it is.

The service shuffles each word's four meanings with the injected `rng` when it writes the round,
and stores `choices` and `right_choice` on the card. The pure function is
`choicesOf(hebrew, wrong, rng)`.

**Eval (`discover `)**, tier 2 gains three checks:
- at most 2 words dropped for their wrong meanings, counted by the parser;
- no kept word's wrong meaning in Latin or Cyrillic script;
- at level ≥ 7, at least 2 multi-word items kept.

A new case, `discover it C1 lower, an adult on their own` (level 9), covers phrases beside the
existing B2 case.

### D5. Adding a word, and the session behind it

- **Adding a card:** the answer's transaction marks the card `lookup_status = 'pending'` and
  enqueues `look-up-discovered-word` (phase 69's job). A card not added gets no lookup.
- **The job, `lookUpWord`:** it runs for a run that is `asking` or ended (`saved`), and never for
  `discarded`. It does phase 69's `lookUpRow`, then one transaction that holds the run's row:
  1. writes the lookup;
  2. if the card is added and the lookup found a gloss, saves it to My words with
     `saveEntriesInTx` (the run's owner as the actor) and stamps the card's `saved_at`.

  A lookup with no gloss leaves the card unsaved, and the wire calls it `failed`. A refused save
  throws, the job retries, and its dead letter marks the card failed (my call: rare, and simple).
- **A gloss that differs from the card's meaning is still saved (my call, builder check B2).**
  This is the case where `hebrew_mismatch` is set: no dictionary sense matched the card's Hebrew,
  so the sense match fell back to the first. Dropping it would lose a word the learner asked for,
  and the first sense is usually the main meaning in other words. The end screen lists a saved
  word by its saved form and meaning, so the learner sees what was saved. The job logs
  `hebrew_mismatch`.
- **The session (Victor: after 2 words, in the background, every run, a waiting session not
  replaced):** a discovery save asks for no delayed stock (builder check B3). If it did, a 30 s
  gap before the 2nd save would stock a session of one word, and the 2nd save could not replace
  it. `saveEntriesInTx`'s `stockSaveDelaySeconds` becomes `number | null`; the other callers
  pass their delay as before. Instead, in the job's transaction, a save that is the run's 2nd
  saved word, or any save after the run ended, calls `requestStock` at once with a new reason
  `discovery`. The stock job makes nothing when a session waits in stock, so a waiting session
  stays.
- **When the run ends:** if it has at least one saved word, it also asks for the stock at once
  (my call: a run that ends at 1 word still gets its session).

### D6. How many, and who started the run

- **Who started it:** the run records `started_by`: `learner` (the מילים חדשות בשבילי button in
  the מילים tab) or `app` (home's or a results screen's My words button sending the learner to
  Words for me).
- **The request (my call):** `POST …/runs` takes `{ goal: 1–30 | null }`. `null` is a run the app
  started, and its goal is the learner's setting (D10).
- **Learner-started (Victor):** the chips "כמה מילים חדשות?" as today (5, 10, 15, 20, 30; 15 picked).
- **App-started (Victor):** no chips. After the level questions on a first run, the cards start.
- **The goal (Victor):** it counts words added. The answer that reaches it ends the run, mid-round
  if so. The round cap (8) and a round with no words also end it.

### D7. When the app sends a learner to Words for me **(Victor)**

Home's action is `discover` in either case:
- the learner has no words (as phase 73);
- every word on the main path has already been introduced.

The main path's current read gains `needs_new_words: boolean`. It is true when all three hold:
1. the main path has saved words;
2. none of them is unmet: every one has a memory row or was introduced today;
3. no app-started run of the enrollment was created on the learner's day today (`learnerDays`).

The third condition means a learner who declines (D8) is sent at most once a day (my call, builder
check B1). Otherwise every practise press of a learner who stopped adding words would land on
Words for me first.

On a target's read the field is false.

The order of home's rules:
1. a started session resumes;
2. then no words at all, or `needs_new_words`, is `discover`;
3. then start, preparing, failed or create, as today.

**Edge cases (my calls):**
- **Words the cap holds back:** a word held back only by today's new-word limit has not been met,
  so it still counts as new.
- **A meaning behind another meaning:** one its family holds back while another meaning of the
  word is learned also counts as unmet (builder check B4). Excluding it would compute the families
  on every home read, and the learner only gets review sessions until that meaning comes up.

**Where else the action applies:**
- **The results screen** draws on the same action, so its continue button opens Words for me too
  (`from=my-words`).
- **A reminder tap** still enters the waiting session: it reads the action without
  `needs_new_words` (my call, builder check B1).

### D8. ✕ **(Victor: no stop button; ✕ is enough)**

During the cards:
- **2 or more words added:** ✕ ends the run (`POST …/end`) and shows the end screen.
- **Fewer than 2:** a bottom sheet warns first:
  - **צריך עוד מילים**
  - כדי להכין לכם תרגול צריך לפחות 2 מילים חדשות.
  - [להמשיך להוסיף] (solid) · [לצאת בכל זאת] (pale)

  "לצאת בכל זאת" leaves with the run open, so opening Words for me again resumes it, as ✕ does
  today.

**(my call, anti-goal)** An app-started run whose learner already has words is the "no new words"
case of D7. There the second button reads "לתרגל בלי מילים חדשות". It ends the run
(`POST …/end`), so the next round is never paid for, then opens the waiting session, or creates
one. That run was created today, so `needs_new_words` stays false for the rest of the day.

Before the cards (the questions, the chips, a round being fetched), ✕ leaves as today.

### D9. The end screen **(Victor: "just show what was added"; start at once when ready)**

What it shows:
- **The count:** the big blue number of words added, then "מילים נוספו למילים שלכם".
- **The list:** one row per word, its word and its meaning. A saved word shows its saved form
  and meaning; one still looked up shows its card's. A word whose lookup failed reads "{word} לא
  נוספה", muted.
- **The bottom**, from the main path's current session:

| State | Bottom |
|---|---|
| a session ready, or started | "✓ התרגול מוכן", then **להתחיל תרגול** |
| no ready session yet | spinner and "מוסיפים את המילים האחרונות…", polled every 3 s |
| no session, no lookup pending, a word saved | the app calls create once, then polls as above |
| no session, nothing pending, no word saved | "לא נוספו מילים", then **חזרה** |
| the session failed | "ההכנה נכשלה", then **חזרה** (home shows its retry) |

**Behaviour (Victor):**
- The screen never waits on lookups when a session is ready; they finish in the background.
- להתחיל תרגול opens the session as phase 73's save did: start, enter, replace to `/session`.
- ✕ on the end screen goes back.

### D10. The setting **(Victor: the 10 is configurable)**

On the new-words settings screen (phase 70) a new group reads "מילים חדשות בשבילי". Its label is
"כמה מילים להוסיף כשנגמרות המילים", with chips 5, 10, 15, 20, 30 and 10 by default.

It is stored per user, as phase 70's limits are: `users.discover_count`, where null means 10. The
wire `NewWordLimits` gains `discover_count`, required both ways.

### D11. Storage and wire

**Migration `0052_discovery_choices`:**
- **`discovery_cards`:**
  - adds `choices jsonb not null default '[]'`, plus `right_choice`, `picked` and `suggested`;
  - adds `added boolean` and `saved_at timestamptz`;
  - the answer check gains `choice`, and `typed` stays for old rows.
- **`discovery_runs`:** adds `started_by text not null default 'learner'`, checked.
- **`users`:** adds `discover_count smallint`, checked 1–30.
- **Data:** every open run (`asking`, `listing`) becomes `discarded`, because its cards have no
  choices and the app no longer draws a list. This is listed for Victor in the PR.

**A run on the wire:**

```
{ id, goal, status, started_by, added_count, round,
  cards: [{ position, word, choices: string[4], right: 0–3 }]   // unanswered, in order
  added: [{ position, word, meaning, status: 'pending' | 'saved' | 'failed' }] }
```

**Removed or changed:**
- **Removed fields:** `unknown_count` and `items`.
- **Removed endpoints:** `PATCH …/items/{position}`, `POST …/save` and `POST …/discard`.
- **Changed:** the answer's body. `CurrentSessionResponse` gains `needs_new_words`, and
  `NewWordLimits` gains `discover_count`.
- **The API level:** `API_LEVEL` goes to 7, because fields are removed and requests change
  (ADR 0012).

Log events:
- **Kept:** `discovery_round`.
- **Changed:** `discovery_answered` now carries `{ pick_right, added, suggested, known }`.
- **New:** `discovery_ended` carries `{ reason, added_count, saved_count }`, and
  `discovered_word_saved` is logged by the job.
- **Removed:** `discovery_listing`, `discovery_saved` and `discovery_discarded`.

### D12. What leaves

These leave with no replacement:
- **Typing a meaning:** the typed answer, its wrong-script refusal and the discovery service's
  meaning judge client.
- **The list:** `DiscoverList`, with its unticking and changing a meaning. `PhotoImportRow` stays
  for photo imports.
- **Other pieces:** ביטול, the "לרשימה" link, and phase 73's `discoverAfterSave` (the end screen
  replaces it).

## Testing

- **Domain (unit):**
  - The prompt's new rules, with phrases only at level ≥ 7.
  - `parseDiscovery`'s wrong-meaning drops.
  - `choicesOf`: always four choices, the right one at `right` and the order from `rng`.
  - `known` as right and not added.
- **Service (unit, fakes):**
  - The answer: suggestion, known, lookup only when added, the goal ending the run, replay.
  - The job: it saves an added card, leaves one with no gloss unsaved, runs for an ended run, and
    asks for the stock at the 2nd save and after the end.
  - `end` asks for the stock when a word is saved.
- **Integration:** the routes' happy path, including the 400 on a bad pick. The auth matrix loses
  the removed endpoints. The current read's `needs_new_words`:
  - a target's word is excluded;
  - a word held back by the cap counts as new;
  - an app-started run today turns it off.

  The new-word limits' `discover_count`.
- **App (unit):**
  - `stepOf`, including an app-started run that skips the chips.
  - The suggestion and the sheet's case.
  - The ✕ rule.
  - The end screen's state.
  - `homeActionOf` with `needs_new_words`, and a reminder tap unaffected by it.
- **E2E:** `discover.spec.ts` follows the new flow, choices then add, and ends on the end screen.
- **Eval:** `discover ` twice, compared with master's report per row.
