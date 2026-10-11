# Phase 35 — Question choosing by knowledge and repetition

- **Status:** Designed on 2026-10-11. Victor scoped the phase in the one-pager and deferred its
  open questions to the design. In brainstorming he chose a memory model over due dates, asked
  for a side research round on how it should work, and approved the design section by section:
  the picker (§1, D1–D8), production for bots (§2, D9–D12), the bots (§3, D13–D17), the driver,
  reports and analysis (§4, D18–D22), and testing with the ADR (§6, D23).
- **Date:** 2026-10-11
- **Source:** `drafts/2026-10-11-question-choosing-one-pager.md` (scope) and
  `drafts/2026-10-11-question-choosing-findings.md` (the research verdict, with citations).
  `drafts/` is gitignored, so everything this spec depends on is restated below.
- **Builds on:** phase 20 (a level per gloss and dimension, picking left uniform on purpose),
  phases 23–27 (the card types), phase 31 (the gloss as the unit, ADR 0011), phase 14 (the
  nightly QA job, whose shape the bot driver reuses), phase 30 (production at app.wordspal.ai).
- **Touches:** a migration (a memory table, a profile kind, a bot day, a session's day). Pure
  domain modules for the model, grading, word choosing and card choosing, replacing the tier
  rotation. One bot-only route. The recompute script. A new top-level `bots/` workspace and a
  `bots.yml` workflow. ADR 0013 and its check script. The e2e specs that assume the rotation.

---

## Goal

A list session picks ten saved words uniformly at random and gives them card types by rotating
three tiers by position. Nothing reads what the learner knows. A learner spends cards on words
they know, meets weak words too rarely, never sees old words again so they fade, and gets cards
whose difficulty ignores their level. Knowledge also differs by dimension: a learner may read a
word well and still not say it.

After this phase a hidden memory model estimates, per word and dimension, how likely the learner
is to recall it today. A session takes the words most at risk of being forgotten, adds a few new
ones, tests each in the dimension that needs it, and gives it a card of fitting difficulty. Words
known well come back over growing intervals, level 5 included. Six bot learners use the product
in production on a clock where one run, about an hour, is one day, and report on it weekly.

**Done means**, in Victor's words from the one-pager, with what brainstorming settled:

1. Bots act as learners on a clock where one hour counts as one day, so results come in a few
   days. (Settled: one hourly run is one simulated day, D18.)
2. The bots report how the sessions feel to them. (Settled: one Claude-written report per bot per
   simulated week, D20.)
3. Their sessions are analysed. (Settled: five numbers per bot per simulated week, shown as
   trends with no pass marks, D21. Pass marks are a later phase, set from this data.)
4. `npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass. ADR 0013's check
   reports a planted violation. `npm run eval` is untouched: no prompt changes.

Items 1–3 are observed after release, because the bots run against production (D9). The PR
delivers everything they need, and its body says what Victor runs to start them.

## Scope

**In:**
- a memory model (FSRS-6, default parameters) per enrollment, gloss and dimension, updated when a
  session ends;
- choosing which words a session asks, which dimension each is tested in, and which card;
- spaced repetition through the model: every word, level 5 included, returns when its estimated
  recall falls below the target;
- all four at once, not staged;
- a learner's day from one place in the server, and each session storing its day;
- a bot kind of profile, a bot's own day, and a narrow bot sign-in route;
- six bot learners, driven hourly from GitHub Actions against production, with hidden memories
  kept off production;
- a Claude-written weekly report per bot, its spend tagged by bot, week and run;
- a weekly GitHub issue with daily lines, the five numbers as trends, the reports and the spend;
- the recompute script rebuilding memory from stored answers;
- ADR 0013 and its check.

**Out:**
- new card types: the picker chooses among the thirteen that exist;
- learner-facing settings: session length, a daily goal, a focus choice;
- showing the schedule: no "due today", no "next review in";
- levels that go down: phase 20's rule stands unchanged;
- fitting the model's parameters, globally or per learner (D2 leaves the seam);
- a baseline run of the bots on today's uniform picking;
- pass marks for the five numbers;
- counting the bots' Gemini spend: Victor reads it from billing;
- a second bot memory family (power law / DASH), added only if the ACT-R results look too good;
- a flag or A/B split between the old and new pickers.

---

## 1. The picker

### D1. FSRS-6 with default parameters, one state per gloss and dimension

The research compared FSRS-6, FSRS-7, half-life regression, SM-2, ACT-R and DASH. On the open
SRS benchmark (about 10k Anki collections, 350M reviews), FSRS-6 with **default** parameters has
log loss 0.3664. That beats DASH (0.3682), ACT-R (0.4033) and HLR (0.4694) even after each of
them was fitted per user. FSRS-7 is slightly better (0.3620), but its gain is below one day, which
a whole-day clock never uses. Its curve is also more complex, and the reference TypeScript library
still implements FSRS-6.

Each (enrollment, gloss, dimension) has its own state. One answer updates each dimension it
evidences independently, as Anki treats sibling cards. Transfer between dimensions is real but
only qualitative in the literature, so nothing couples dimensions beyond the "a success credits
downward" rule the level rule already uses (D3).

**Why not due dates.** A due-date scheduler was the alternative presented. Victor chose the
model. The bots' memory is a different model family (D14), which keeps the test from grading the
picker by its own assumptions.

### D2. The model's state and update

State per row:
- `stability` (S), in days;
- `difficulty` (D), from 1 to 10;
- `last_day`, a UTC date;
- `reps` and `lapses`;
- `params`, the parameter-set id, `fsrs6-default` for now.

A dimension with no row is **unintroduced**. Every function is pure and takes the day as an
argument (ADR 0001 R3).

Default parameters (FSRS-6, from py-fsrs and the algorithm wiki):

```
w = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796,
     1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542]
```

Grades are 1 Again, 2 Hard, 3 Good. Easy is never used: its bonus (w16 = 1.87) is one no card
here can justify.

```
R(t, S)  = (1 + F·t/S)^(−w20),        F = 0.9^(−1/w20) − 1
first:     S = w[G−1];  D = clamp(w4 − e^(w5·(G−1)) + 1, 1, 10)
t ≥ 1, G ≥ 2:  S' = S·(1 + e^w8·(11−D)·S^(−w9)·(e^(w10·(1−R)) − 1)·(G = 2 ? w15 : 1))
t ≥ 1, G = 1:  S' = min(w11·D^(−w12)·((S+1)^w13 − 1)·e^(w14·(1−R)),  S / e^(w17·w18))
t = 0:         S' = S·m,  m = e^(w17·(G − 3 + w18))·S^(−w19),  m ≥ 1 when G ≥ 2
always:        D' = clamp(w7·D0(Easy) + (1−w7)·(D − w6·(G−3)·(10−D)/9), 1, 10)
               D0(Easy) = w4 − e^(w5·3) + 1, unclamped (≈ −4.77)
               S' is floored at 0.001
```

Difficulty mean-reverts toward D0(Easy), taken unclamped, and stability is floored at 0.001
after every update, as py-fsrs does (ruling 12).

`t` is whole days since `last_day`. Reviews are applied in answer order. Within one day, the first
review of a row uses the long-term rule and any later one uses `t = 0`. Same-day R is never used
to rank anything: R(0) is 1, and FSRS-6 predicts same-day reviews poorly.

What the defaults do, as a test fixture: a first Good gives S = 2.3065, and Good at each due
date, reviewed at round(S) days (Anki's interval at retention 0.9), then gives intervals of 2,
11, 46 and 163 days. From S = 2.3065 reviewed at t = 2 whole days, Hard gives 7.51, Good 10.96
and Again 0.608 (ruling 10).

**Written here, not imported.** The formulas are about a hundred lines in
`packages/core/src/domain/memory.ts`, where the server and the FSRS control bot both import them. The TypeScript library works in timestamps and fractional
days, and this model works in whole UTC days. Its unit tests pin the interval sequence above and
a few values computed with py-fsrs, so any drift from the reference fails a test.

**The fitting seam.** `params` on every row, and the parameter sets held in one module keyed by
id, mean a later fit per language pair, or a move to FSRS-7, is a new id and a recompute, not a
migration.

### D3. Grading: card and verdict to a grade per dimension

`packages/core/src/domain/memoryGrades.ts`, so the bots read the same table (D16). It is the
memory model's counterpart of the level rule's `evidenceFor`. Dimension codes:
WR written receptive, WP written productive, SP spelling, SR spoken receptive, SK spoken
productive. "–" means the verdict cannot occur, and "—" means no update.

| Card | Right / exact | Near miss | Wrong | Alternative | Gave up | Skipped |
|---|---|---|---|---|---|---|
| Multiple choice | WR Good | – | WR Again | – | – | – |
| Matching board, first try | WR Hard | – | WR Again | – | – | – |
| Typed meaning | WR Good | WR Good | WR Again | — | WR Again | — |
| Listen and choose | SR Good | – | SR Again | – | – | – |
| Read aloud | — | – | — | — | — | — |
| Reverse choice, cloze choice | WR Good, WP Hard | – | WP Again | – | – | – |
| Letter tiles | WR Good, WP Hard | WP Again | WP Again | — | WP Again | — |
| Typed translation, typed cloze, sentence translation | WR, WP, SP Good | WR, WP Good; SP Again | WP Again | — | WP Again | — |
| Dictation | SR, SP Good | SR Good; SP Again | SR Again | — | SR Again | — |
| Say the translation, spoken | SR, SK Good | – | – | — | SK Again | — |
| Say the translation, typed fallback | as typed translation | | | | | |

The rules behind it:
- A success in the dimension's own format is **Good**. A success through an easier, capped format
  (picking or building the word from what is given, or the board, where elimination makes the
  last pair free) is **Hard**.
- **Gave up** is Again here, a failure to recall, although the level rule records nothing for it.
- **Alternative** updates nothing: it is evidence about another gloss.
- **Read aloud** updates nothing: the word is shown, so nothing is retrieved.
- **Answer time** is not used. FSRS reads only intervals and grades, and the benchmark shows no
  gain from it.
- An "unheard" transcript records nothing, as for levels.

### D4. Writing memory when a session ends

`recordProgress` (`services/sessions.ts`) already updates levels in the transaction that ends a
session. The same transaction now also reads the memory rows of the practised glosses, applies
the session's graded answers in order with the session's stored day (D10), and upserts the rows.
A session that ends without its memory update, or memory written for a session that did not end,
cannot happen (ADR 0001 R8). Only saved glosses have memory, so an answer about an unsaved gloss
counts for nothing, as for levels.

### D5. Choosing the words, when a session is created

A pure function, `chooseWords` in `apps/server/src/domain/choose.ts`. It takes:
- the saved glosses;
- their memory rows and levels;
- today, for this learner (D10);
- the glosses answered earlier today;
- the count of new glosses introduced today;
- the device's listening and speaking flags.

It returns up to ten picks, each with a dimension and a rung (D6).

```
LIVE  = {WR, WP, SP} ∪ {SR if listening} ∪ {SK if speaking}
ORDER = [WR, WP, SR, SP, SK]                      # introduction order, easiest first
N     = min(10, number of saved glosses)          # after D18 of phase 31: one per normalised key

for each saved gloss g:
  if g has no memory row in any dimension:      class NEW
  else:
    weak(g) = the dimension in LIVE with a row and the lowest R(today − last_day, S)
    need(g) = R of weak(g)
    if need(g) <= R_TARGET:                     class DUE    # ruling 11: back on day ceil(S)
    elif some dimension in LIVE has no row:     class EXPAND   # introduce the next one in ORDER
    else:                                       class NOT_DUE

take DUE glosses not asked today, by need ascending
add NEW glosses, newest saved first (ties at random):
    k_new = min(|NEW|, NEW_PER_SESSION, DAY_NEW_CAP − new_today), at least 2 when the cap allows
fill, in this order, until N:
    EXPAND → more NEW up to DAY_NEW_CAP → NOT_DUE by need ascending → glosses asked today by need
while filling, skip a gloss that would break:
    at most PER_DIMENSION_CAP picks testing one dimension
    at most HARD_CAP picks whose best card has expected success below 0.6
```

Lowest recall first follows MEMORIZE (optimal review intensity proportional to 1 − R) and is
Anki's "ascending retrievability" sort. A level-5 word returns whenever its R falls below the
target, so intervals keep growing with S. The dimension cap keeps a newly capable device's
spoken backlog from flooding one session. The hard-card cap keeps a session from being mostly
failures.

Today's uniform `pickGlosses` keeps its one-per-normalised-key rule (phase 31 D18). `chooseWords`
works on what that rule allows, and `pickGlosses` and `pickSenses` are removed.

### D6. Choosing the card, when the session is prepared

Card eligibility needs the word's form and saved example (tiles, speakable, cloze gap), which only
the preparation job reads. The job therefore chooses the type. It replaces `planSession` and its
tier rotation (`domain/plan.ts`).

Dimension per pick, decided in D5:
- DUE: `weak(g)`;
- EXPAND: the next unintroduced dimension in ORDER;
- NEW: WR.

Rungs: recognition (rung 1) when the level is 1–2 or R is below `RUNG_R`; recall (rung 2) when the
level is at least 3 and R is at least `RUNG_R`.

| Dimension | Rung 1 | Rung 2 |
|---|---|---|
| WR | multiple choice (board-eligible) | typed meaning |
| WP | reverse choice, cloze choice, letter tiles | typed translation, typed cloze, sentence translation |
| SP | dictation (when listening) | typed translation, typed cloze |
| SR | listen and choose | dictation |
| SK | read aloud, once, while SK is unintroduced or below level 2 | say the translation |

Within the rung, among the eligible types, the job estimates each card's chance of success:

```
p = g + (1 − g)·R^e      g = 0.25 for a four-option card, else 0
                         e = RECOGNITION_EXPONENT for rung 1, 1 for rung 2
```

It picks the card whose `p` is nearest `CARD_TARGET`. Ties go to the type used least so far in
the session, and no type is used more than four times. A NEW gloss has no R, so it takes
multiple choice. When a rung has no eligible type, the job takes the other rung. When neither
rung has one, it takes multiple choice, which is always eligible.

The rungs respect the level caps by construction: a capped card is rung 1, and rung 1 is chosen
only below level 3 or at low R.

**Order.** The highest-`p` card comes first. No type appears twice in a row where it can be
avoided. When the session has at least `BOARD_MIN_PICKS` (7) picks, as today (ruling 18), and at
least four picks have multiple choice and their forms and meanings all differ, four of them
become a matching board, reusing `boardPicks`. Otherwise the session has no board.

Choosing the card is about aiming: the evidence is for effortful but successful retrieval
(Pyc & Rawson 2009), and recall was best at thresholds of 0.86–0.94, with 0.98 and 0.40 both
worse (Eglington & Pavlik 2020).

### D7. Every number the research chose is a named constant

`apps/server/src/domain/chooseConstants.ts` holds these:

| Constant | Value | Source |
|---|---|---|
| `R_TARGET` | 0.90 | Anki's default; inside Eglington & Pavlik's 0.86–0.94 |
| `CARD_TARGET` | 0.85 | research's choice |
| `RUNG_R` | 0.75 | research's choice |
| `RECOGNITION_EXPONENT` | 0.5 | research's choice |
| `NEW_PER_SESSION` | 3 | research's choice |
| `DAY_NEW_CAP` | 15 | research's choice; Anki's default is 20 cards a day |
| `PER_DIMENSION_CAP` | 4 | research's choice |
| `HARD_CAP` | 4 | research's choice |

The research marked every "research's choice" as a starting value for the bots to tune. Tuning
is a one-line change, made in a later PR once the weekly numbers show the need.

### D8. Starting state: the recompute rebuilds memory

`db/progressRecompute.ts` replays every ended session in the order it ended, through the same
`evaluateSession`. It now also replays the same answers through D3 and D2 into the memory table,
with each session's stored day. Glosses with no answers stay NEW. There is far too little data to
fit parameters (lane 0 has 41–203 answers per enrollment over 8 days), so the replay only
initialises state with the defaults. It runs once in production after the release (§4).

---

## 2. Production for bots

### D9. Bots use production

The bots run against `app.wordspal.ai`. Production is always on, and its database keeps the bots'
state between runs, so the driver can stay stateless towards the server. The bots test what
learners get. Victor accepted four consequences:
- a bot clock in the server (D10, D11);
- a bot-only sign-in (D12);
- bot data beside learners' data, marked (D11);
- results only after release, because bots see released code.

The bots use production's Gemini key for card generation, judging and transcription.

### D10. A learner's day comes from one place

Today the level rule's day is derived in SQL from the latest `answered_at` of a session, in UTC
(`repo/progress.ts`). After this phase:

- `services/learnerDay.ts` exports `learnerDay(repos, userId, now)`. It returns the UTC date of
  `now` for a learner, and the profile's `bot_day` for a bot. It is the only place a progress day
  is computed (ADR 0013).
- `sessions.practice_day` (date, null until the session ends) is set from `learnerDay` in the
  transaction that ends the session. The level rule, the memory update and the recompute all read
  it. The migration backfills ended sessions with the day today's SQL derives, so nothing moves.
- `chooseWords` gets today from `learnerDay`. "Asked today" and "new today" are counted over
  sessions whose `practice_day` is today, with a session still open counting as today.

### D11. A bot is a kind of profile, with its own day

`users.kind` is `'learner' | 'bot'`, default `'learner'`, with a check. `users.bot_day` is a
nullable date, set for bots only (a check: non-null exactly when the kind is bot). Bot profiles
are created only by the server command `npm run db:bots:create -- --day <date> <names>`, whose
`--day` is required (ruling 21: ADR 0013 R1 keeps "today" in `learnerDay`), run by Victor against production
(§4), because ADR 0009 R6 keeps `insert(users)` in `repo/users.ts`. It creates
each auth identity and profile with `kind = 'bot'` and a `.invalid` email that no mail can reach.
Nothing in the app's sign-up path can create one. Anything that later counts learners filters
`kind = 'learner'`.

### D12. The bot route

One file, `routes/bots.ts`, mounted only when `BOT_SECRET` is configured. It is absent on every
lane, in CI and in tests unless they set it. It has two operations:

- `POST /bots/sign-in` with `{ name }` returns a normal Better Auth session for the bot profile
  named `name`, created through `auth/betterAuth.ts`'s server API, the one place Better Auth is
  imported (ADR 0009 R1).
- `PUT /bots/day` with `{ name, day }` sets that profile's `bot_day` to `day`. The value is
  explicit, so a retried run sets the same day again rather than skipping one.

Both operations have the same guards:
- `Authorization: Bearer <BOT_SECRET>`, compared in constant time;
- a 404 for any profile whose kind is not bot, the same as an unknown name, so the route can
  never sign anyone in as a learner;
- one `bot_route` log line per call, with the operation and the name.

`BOT_SECRET` lives in production's Secrets Manager, which reaches the container through
`secret_env_names` in `terraform/prod/variables.tf` (ruling 28), and in the repository's GitHub
secrets.
Writing it is Victor's (§4). Both operations are declared with `createRoute`, with their schemas
in `packages/core` (ADR 0003 R1, R2). They appear in the OpenAPI document only where the route
is mounted.

**Rejected:** bots signing in through the emailed-code flow, with the server keeping bot codes
for the driver to fetch. That needs the same secret to fetch the code, so it adds steps without
making anything safer.

---

## 3. The bots

### D13. The roster

Six bots in `bots/roster.ts`:

| Name | Memory | Language | Sessions a day | Plays | Devices |
|---|---|---|---|---|---|
| `steady-en` | ACT-R, average | English | 1, sometimes 2 | every day | listening, speaking |
| `fast-ru` | ACT-R, low decay | Russian | 2–3 | every day | listening, speaking |
| `forgetful-it` | ACT-R, high decay | Italian | 1 | every day | listening, speaking |
| `skipper-en` | ACT-R, average | English | 1 | about two days in three | listening, speaking |
| `silent-ru` | ACT-R, average | Russian | 1–2 | every day | listening only |
| `control-it` | FSRS-6, defaults | Italian | 1–2 | every day | listening, speaking |

Sessions within a day are spaced at simulated hours, for example 08:00 and 20:00. The bot's
memory decays between them, while the server sees one day. Each bot's random draws are seeded
from its name and the day, so any day can be replayed exactly.

### D14. The bots' memory: ACT-R, not FSRS

Each ACT-R bot keeps, per word and dimension, the times of its practice traces (Pavlik & Anderson
2003, 2005):

```
activation      m = ln Σ_j t_j^(−d_j)          t_j: simulated time since trace j, in seconds
decay of trace  d_j = c·e^(m_(j−1)) + a         a = 0.167, c = 0.232
recall          P = 1 / (1 + e^((τ − m)/s))     s = 0.252, τ = −0.669
between-session time is scaled by h = 0.031
```

Ages are in seconds, the unit the parameters are fit to (ruling 30); the bot's clock runs in
simulated hours and converts. In hours the same parameters barely forget.

What the bots add to that:
- **Hidden difficulty.** A per-word, per-bot shift of τ, drawn once and never visible to the
  picker.
- **Transfer.** Productive practice adds a weaker trace to the receptive dimension below it, and
  written and spoken practice add small traces to each other.
- **Guessing.** On a four-option card, P becomes 0.25 + 0.75·P.
- **Slips.** A per-bot chance that a recalled form is typed with one letter wrong.

The profiles in D13 vary decay (`a`), τ and the slip chance.

It is a different functional form from the picker's: massed practice is penalised through
activation, not through R in a stability gain. It also has heterogeneity and transfer the picker
cannot see. The research found that scheduler rankings change with the student model, and that
a policy matched to its simulator wins by construction (Reddy et al. 2017). That is why the bots
must not forget the FSRS way.

**The control bot** forgets by FSRS-6 with the same defaults, reusing `memory.ts`. It shows how
the picker does when its assumptions are exactly true. A gap between it and the ACT-R bots
measures how much the assumptions matter.

### D15. Words to learn

`bots/words/{en,ru,it}.txt` hold frequency-ordered word lists, a few thousand each, from a
permissively licensed source named in the file's header. Each played day a bot looks up and
saves the next few words from its list, at a rate its profile sets (two to six). With a small
daily chance it saves a burst of thirty, the way a photo import does. Lookups and saves go
through the public API exactly as the app's do, so the shared dictionary fills once.

### D16. Answering a card

1. **Which word.** The bot matches what the card shows against its saved list: the form, the
   Hebrew prompt, or the sentence's marked word. A card it cannot match is answered at random and
   counted as `unmatched` in the log and the daily line.
2. **Which dimension.** The card type's dimensions, from the same table as D3.
3. **Right or wrong.** A draw against its memory's P for that dimension.
4. **The answer:**
   - **Choice cards:** the right option, or a wrong one.
   - **Typed cards:** right gives the form, or a near miss on a slip draw. Wrong gives another
     word from its list, or an empty answer, which is gave up, at a profile rate.
   - **Speaking cards:** the bot synthesises the answer with espeak-ng on the runner, encodes it
     as WebM with ffmpeg, and sends it as the app does. Right says the word, wrong says another
     word, and gave up takes "show me the answer". A card that comes back `unheard` takes "show
     me the answer", and the log counts it.
5. **What the bot learns.** Every card adds a trace to the dimensions it exercised, right or
   wrong, and the right answer it then sees adds a weaker one.

### D17. The hidden truth stays off production

Each bot's state lives as JSON on an orphan branch, `bots-state`, one directory per bot. The
state covers its memory traces, its word-list position, its hidden difficulties, and an append-only
log of every card: day, hour, card type, word, dimension, P before, answer and verdict. The
driver reads it at the start of a run and commits each bot's state as soon as that bot's day is
done. Production never sees what a bot really knows.

---

## 4. The driver, reports and analysis

### D18. The schedule: one run is one simulated day

`.github/workflows/bots.yml`, separate from `ci.yml`:
- runs at `17 * * * *` and on manual dispatch;
- `concurrency: bots`, with no cancel, so a late run queues behind the one before;
- `timeout-minutes: 55` (30 as first written; under the hourly cadence, a long run only queues the next);
- skipped on forks;
- skipped unless the repository variable `BOTS_ENABLED` is `true`, so Victor can stop it without
  a code change.

For each bot, a run:
1. signs in through D12;
2. sets the bot's day to `state.day + 1`;
3. plays the day;
4. commits the state.

All bots share one day number. A bot whose run fails keeps its old day, and the next run goes
on with that day from where it stopped (ruling 31).
GitHub's hourly schedule drifts and sometimes skips, so the bots average somewhat under 24 days
per real day. Nothing breaks: a skipped run is a slower week, never a lost day.

### D19. Failures

- A bot's failed request is logged, and the bot's day ends early. Failures include a production
  deploy, a Gemini outage, or a session whose preparation fails. The run goes on to the next bot.
- An error in the driver itself fails the job, which shows red, as the nightly QA job does.
- The daily line counts each bot's failed requests, so a pattern shows in the issue.

### D20. Reports, on Victor's Claude subscription

At the end of each simulated week (day 7, 14 and so on), the driver makes one Claude CLI call per
bot:
- `CLAUDE_CODE_OAUTH_TOKEN`, as the nightly QA job uses;
- `--model` pinned to Sonnet;
- no tools and `--max-turns 3`;
- `--output-format json`.

The prompt is the bot's profile and a summary of its week: cards, results, which words came back
and after how many days, how many new words, and its unheard and unmatched counts. It asks for a
short report in the bot's voice on how the sessions felt: too easy, too hard, the same word
again, words it had forgotten that never came back.

From the CLI's JSON, the log keeps `total_cost_usd` and the token counts, tagged with the bot,
the simulated week and the workflow run id. A hard limit of six report calls per run is in code,
so a bug cannot loop on the subscription. Gemini spend is not counted (Out).

### D21. The five numbers

Pure functions in `bots/src/analysis.ts`, per bot per simulated week, from the log and the hidden
memory:

| # | Number | Computed as |
|---|---|---|
| a | Weak words get the practice | share of cards on words whose true P (at the card, in the tested dimension) was below 0.7, divided by those words' share of the saved list that week |
| b | Weak dimensions get their cards | for words whose lowest-P dimension was at least 0.2 below their best, the share of their cards testing that lowest dimension |
| c | Intervals grow | the median gap in days between reviews of a word and dimension, for the second, third, fourth and later reviews in a row answered right |
| d | Difficulty fits the level | share of cards whose rung disagrees with the level and R the server's rule implies, recomputed from the log |
| e | The bot remembers more | mean true P over every saved word and live dimension at the end of the week |

The closing comment shows each number for the week and every earlier week. A value above 1 for
(a), a rising (c), a low (d) and a steady or rising (e) are what the choosing is for. No
threshold is applied (Out).

### D22. The weekly issue

The issue is titled "Bots — simulated week N", has the label `bots`, and is opened by the first run
of the week. Its body describes the roster.

- **Each run** adds one comment with a line per bot: sessions, cards, share right, new words,
  unheard, unmatched, failed requests.
- **The week's last run** adds a closing comment with three parts:
  - the table of the five numbers per bot against earlier weeks;
  - the six reports;
  - the week's Claude spend per bot, with the total and the running total since day 1.

Issues are written through the GitHub CLI with the workflow's `GITHUB_TOKEN` (`issues: write`).
That needs nothing new from Victor. Issues created with that token trigger no further workflows.

---

## 5. Changes

### Data (one migration, numbered after phase 34's 0027)

- `gloss_memory`:
  - columns: `enrollment_id`, `gloss_id`, `dimension`, `stability` real, `difficulty` real,
    `last_day` date, `reps` int, `lapses` int, `params` text;
  - primary key `(enrollment_id, gloss_id, dimension)`;
  - a foreign key to `vocabulary_entries` with `ON DELETE CASCADE ON UPDATE CASCADE`, as
    `gloss_progress` has;
  - checks: the dimension is known, stability is positive, difficulty is between 1 and 10.
- `users.kind` (text, not null, default `'learner'`, checked) and `users.bot_day` (date,
  nullable), with a check tying the two together.
- `sessions.practice_day` (date, nullable), backfilled for ended sessions.

### `packages/core`

- `domain/memory.ts` (D2) and `domain/memoryGrades.ts` (D3), new and pure.
- The bot route's request and response schemas (D12).
- Nothing on the wire changes for the app.

### Server

| File | Change |
|---|---|
| `domain/choose.ts`, `domain/chooseConstants.ts` | new, D5–D7 |
| `domain/plan.ts` | `planSession` replaced by the card choice and order of D6; `boardPicks` kept |
| `domain/session.ts` | `pickGlosses` and `pickSenses` removed |
| `services/learnerDay.ts` | new, D10 |
| `services/sessions.ts` | create: `chooseWords`, picks carry dimension and rung into the job payload. Prepare: D6. End: `practice_day`, memory (D4) |
| `repo/memory.ts` | new: read and upsert memory rows |
| `repo/progress.ts` | the session's day from `practice_day` |
| `repo/users.ts` | `kind` and `bot_day` reads and the bot-day write |
| `routes/bots.ts`, `app.ts`, `config.ts` | D12, mounted on `BOT_SECRET` |
| `db/progressRecompute.ts` | D8 |

### Bots (new workspace `bots/`)

- **Profiles and words:** `roster.ts`, `words/`.
- **Memory:** `src/actr.ts`, and `src/fsrsBot.ts`, which imports `memory.ts` from
  `@lang-tutor/core`. The root `package.json` adds `bots` to its workspaces.
- **Playing:** `src/answer.ts`, `src/speech.ts` (espeak-ng and ffmpeg), `src/api.ts` (the public
  API and D12), `src/play.ts` (one bot's day).
- **Output:** `src/report.ts` (D20), `src/analysis.ts` (D21), `src/issue.ts` (D22).
- **State:** `src/state.ts`, which reads and commits the `bots-state` branch.
- **Entry point:** `run.ts`, the driver, with `--dry-run` against a local lane (§6).

### CI and docs

- `.github/workflows/bots.yml` (D18).
- `ci.yml` runs the `bots/` unit tests in the existing unit job.
- `docs/adr/adr-0013-learner-day.md` and `scripts/check-adr-0013-learner-day.sh` (D23).
- `docs/runbooks/bots.md`: start, stop, read the issue, rerun a day, reset a bot.

---

## 6. Testing

### D23. ADR 0013: a learner's day comes from one place

The ADR has three rules, each enforced by the check script:
- **R1.** Only `services/learnerDay.ts` computes a progress day. In any other non-test file under
  `apps/server/src`, the script refuses `AT TIME ZONE 'UTC')::date` and `.toISOString().slice(0, 10)`.
- **R2.** `bot_day` is read or written only in `repo/users.ts`.
- **R3.** `routes/bots.ts` is the only route file that names `kind = 'bot'` or `BOT_SECRET`.

A future change that read the date another way would quietly break the bots' clock without
failing anything else. As CLAUDE.md requires, each rule is first planted as a violation, and the
script must report it.

**Unit tests:**
- `memory.ts`: the interval fixture of D2, values against py-fsrs, the same-day rule, and the
  clamps;
- `memoryGrades.ts`: every row of D3's table;
- `choose.ts`:
  - the class order;
  - lowest need first;
  - the new-word floor, per-session limit and daily cap;
  - glosses asked today last;
  - both caps;
  - spoken dimensions only when the device allows;
  - a list smaller than ten;
  - a list of only NEW;
- the card choice in D6: rungs by level and R, the `p` target, ties by least-used type, the
  cap of four per type, rung and multiple-choice fallbacks, the board, and the order;
- `bots/src`: ACT-R recall against hand-computed values, guessing, transfer, seeded
  replay, answer generation per card type, each of the five numbers on small handmade logs, the
  issue text, and the report-call limit.

**Integration tests** (the `integration` project, a real database):
- ending a session writes memory and levels together, and a failure writes neither;
- `practice_day` is set, and the backfill matches the old derivation on fixture sessions;
- for a bot, `PUT /bots/day` moves its day, and the level rule's 1/7/21-day gaps count bot days;
- the bot route is absent without `BOT_SECRET`, refuses a wrong secret, and gives a 404 for a
  learner's name;
- the recompute rebuilds memory equal to what the live path wrote;
- a created session's picks follow `chooseWords` on seeded memory rows.

**e2e.** Some specs rely on the rotation's fixed type per position. A fresh enrollment's words
are all NEW, so the first list session is mostly multiple choice. The speaking, listening,
dictation and cloze specs get setup that reaches their card: memory rows seeded through the test
database so the wanted dimension and rung come out. The seeded rows are named per spec.

**Driver dry run.** `npm run bots:dry -- --days 3` runs `run.ts` against the lane's server with
its own `BOT_SECRET`. It plays three days for every bot, writes the issue text to a file, files
nothing, and makes no Claude call.
- **Locally**, it can use the lane's real Gemini key, to watch real cards.
- **In CI**, it uses MockServer in its own namespace, as e2e does, and a fixture word list of ten
  words per language, with expectations for their lookups, card generation and transcription.
  It runs in the integration job, so a broken driver fails before release.

**Evals.** Untouched: no prompt changes.

---

## Left for Victor

These go, with exact commands, in the PR body. In order:

1. Delete the test incident's `bots-state` branch, before `BOTS_ENABLED` is ever set (ruling 27).
2. Generate `BOT_SECRET` and write it to production's Secrets Manager and to the repository's
   GitHub secrets; set the repository variable `BOTS_API_URL`.
3. Merge and release as usual (the release applies `terraform/prod`, which passes `BOT_SECRET`).
4. Run the memory recompute against production.
5. Run `npm run db:bots:create -- --day 2026-01-01 <names>` against production to create the six
   bot profiles.
6. Set the repository variable `BOTS_ENABLED` to `true`.

`docs/runbooks/bots.md` (*Start*) has the exact commands.

The first weekly issue appears about seven hours later.

## Build order

1. Migration, `learnerDay`, `practice_day` with its backfill; the level rule reads it. ADR 0013
   and its check.
2. `memory.ts`, `memoryGrades.ts`, the memory write at session end, the recompute.
3. `choose.ts` and the new card choice, replacing the rotation; the e2e specs.
4. `kind`, `bot_day`, the bot route.
5. The `bots/` workspace: memory, answering, speech, playing, the dry run.
6. Reports, analysis, the issue, `bots.yml`, the runbook.

## Risks

- **Defaults overestimate weak words' recall.** The defaults come from self-graded flashcards,
  and four-choice cards have a 25% guessing floor. The picker may then under-serve exactly the
  weak words. The signs:
  - (a) is not above 1;
  - (b) is no higher than a uniform share;
  - (e) is flat while the share right stays above 85%.

  The first fixes are a higher `R_TARGET`, a lower `RECOGNITION_EXPONENT`, or grading four-choice
  successes Hard.
- **New-word limits.** If (e) falls while (c) grows fast, the new-word cap is too high. If (e)
  stalls for bots with mostly unpractised lists, it is too low.
- **espeak-ng and transcription.** A robotic voice may often come back unheard, leaving SK
  under-tested. The daily unheard count shows it. The fallback is a better voice on the runner, a
  later change.
- **Unmatched cards.** Two saved words with the same translation can make a card ambiguous to the
  bot. The unmatched count shows how often.
- **Phase 34 in flight.** It owns migration 0027 and changes question generation. This phase
  numbers its migration after it and merges master early when phase 34 lands.
- **Production deploys mid-run** fail one bot's day, which repeats next run (D18, D19).
- **Minting a bot session.** D12 assumes Better Auth's server API can create a session for a
  known user. If it cannot, the fallback is the rejected alternative in D12: the server keeps a bot
  address's code for the route to return. That is the same secret behind the same guards.
- **Subscription use.** About twenty report calls a real day, capped per run. If it competes
  with Victor's sessions, the reports can move to every second week with one constant.

## As built

Controller rulings made during the build that changed or pinned down the design above. The text
above is corrected where a ruling contradicted it; the rest refine it.

- **Ruling 1.** ADR 0013 R2 exempts `db/schema.ts` and `db/migrations/`, which must declare `bot_day`.
- **Ruling 3.** One `expectedSuccess(r, fourOption, rung)` in `domain/choose.ts`; HARD_CAP uses the rung's best card.
- **Ruling 4.** A bot's auth identity is inserted in `repo/auth.ts` and its profile in `repo/users.ts`, in one transaction.
- **Ruling 5.** The CI dry run reuses the e2e job's server and MockServer namespace, after e2e.
- **Ruling 7.** The learner-day ADR is 0013 (0012 was taken on master); corrected throughout.
- **Ruling 9.** ADR 0013 does not scan test files, and R3 scans `apps/server/src/routes` only.
- **Ruling 10.** D2's fixture reviews at round(S) days; whole-day Hard/Good/Again from S = 2.3065 at t = 2 are 7.51 / 10.96 / 0.608.
- **Ruling 11.** DUE is need ≤ R_TARGET, so a word returns on day ceil(S).
- **Ruling 12.** Difficulty reverts toward D0(Easy), unclamped, and stability is floored at 0.001, as py-fsrs does.
- **Ruling 14.** Two NEW slots are held when NEW exists and the cap allows; caps defer rather than drop; "new today" counts glosses first answered today.
- **Ruling 15.** NEW glosses past DAY_NEW_CAP fill a session as a last resort, so it is never short while saved glosses remain.
- **Ruling 16.** Read aloud is offered only while SK is below level 2.
- **Ruling 17.** Multiple choice forced on NEW glosses and fallbacks does not count toward the four-per-type cap.
- **Ruling 18.** A board needs at least BOARD_MIN_PICKS (7) picks.
- **Ruling 19.** The board takes its position by p, the highest of its four.
- **Ruling 20.** e2e seeds memory by gloss key, not form.
- **Ruling 21.** `db:bots:create` takes a required `--day`; bot names are `[a-z0-9-]{3,30}`; a bot session lasts one day; `claimAccount` refuses bots.
- **Ruling 22.** The raw `app.all('/api/bots/*')` 404 is an accepted exception to ADR 0003 R1.
- **Ruling 23.** The bot knobs D13 leaves open are documented choices in `bots/src/roster.ts`.
- **Ruling 24.** A bot learns from the server's verdict, not from what it meant to answer.
- **Ruling 25.** The word lists drop contraction fragments, number words and function words.
- **Ruling 26.** All bots play the lowest finished day + 1; a bot day failing three times counts as played; a saved word also matches by lemma and gloss key.
- **Ruling 27.** Deleting the test incident's `bots-state` comes before `BOTS_ENABLED` is set.
- **Ruling 28.** `BOT_SECRET` is in `terraform/prod`'s `secret_env_names`.
- **Ruling 29.** Analysis (d) infers the dimension from the card type and counts fallbacks as rung disagreements.
- **Ruling 30.** ACT-R ages are in seconds; `forgetful-it` became a = 0.2, τ = −0.6 so it still learns.
- **Ruling 31, final fix wave.** DUE words left after the NEW reservation are offered before EXPAND; a bot day saves its state after every session and on a crash, and a later attempt resumes it rather than replaying it; a tracker failure before a day is logged and the day is played (the run still ends red); a gloss merge folds memory, keeping the larger stability per dimension; the job's timeout is 55 minutes; the bots' audio cap is 200,000 bytes.
