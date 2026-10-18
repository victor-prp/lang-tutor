# Phase 64 — Home, a bar and one look

- **Status:** Victor approved the design in the mockups on 2026-10-18, answered the builder check's two
  questions (R12, R13) and said "Go till the PR". His rulings are at the end.
- **Date:** 2026-10-18
- **Source:**
  - The one-pager: `drafts/2026-10-18-home-and-options-one-pager.md` (main checkout).
  - The brainstorming chat of 2026-10-18 and its mockups, in `.superpowers/brainstorm/29652-1792337655/content/`
    (main checkout). Approved:
    - `style-a-all-screens.html`: the look on every tab, translate and the photo flow's last step (R5, R11).
    - `photo-flow.html`: the photo flow, steps 1–5 (R4).
    - `home-carousel.html`, option 3: one card at a time, as a stack (R6).
    - `countdown-options.html`, option 1: the blue header (R7).
    - `band-all-cards.html`, option A: blue for every card (R8).
    - `urgency-combined.html`: the fuse and the "not ready" line, in four states (R9).
  - Superseded by the files above, kept for the record: `bar-options.html`, `top-actions.html`, `four-tabs.html`,
    `style-directions.html`, `style-a-variants.html`, `style-new-directions.html`, `style-d-e-screens.html`,
    `style-e-colours.html`, `style-e-colours-2.html`, `new-concepts.html`, `urgency-marks.html`,
    `urgency-marks-2.html`.
- **Builds on:**
  - phase 57 (home's order, D11, and the target card), phase 53 (targets and the wizard), phase 26 (photo
    import), phase 52 (reminders and `start=reminder`), phase 43 (home makes the next session)
  - ADR 0012 (`API_LEVEL`), ADR 0013 (the learner day)
- **Touches:**
  - the app: the root layout and a new tab group; home becomes the **תרגול** tab; vocabulary becomes the
    **מילים** tab; profile splits into the **אני** and **הגדרות** tabs; the header; the target card; one photo
    flow in place of today's two; the theme; e2e
  - core and the server: one added field on a target's summary (D5)

---

## Goal

Victor (one-pager): home is crowded: practice cards, tools and buttons in one long column, so the next thing
to do is unclear. The common options are scattered and hard to find. Home looks unfinished. In the chat: "I
know all options, so I can do whatever I need, but it's not very convenient or intuitive, it doesn't look like
a polished home screen, and there's no menu bar, so I can't jump to what I need without the home screen."
Duolingo feels right to him: the bar and the single obvious next step, without the cartoon look.

This phase gives the app a bar along the bottom, a header with the two most common actions, a home that shows
one card at a time, and one look on every screen in scope.

**Done means** (the one-pager):

1. Victor approves the concept as mockups before anything is built. The mockups above meet this.
2. Every screen in scope follows the one concept: the same header, buttons, cards and colours, so home, the
   options, vocabulary and targets look like one app.
3. *(Mine, as in every phase.)* Automated tests prove it, and `npm test`, `npm run test:all`,
   `npm run lint:arch` and `npm run e2e` pass.

## Scope

**In:**
- the bar (D1) and the header (D2)
- **תרגול**: one card at a time (D3), the card (D4), urgency (D5)
- **מילים** (D6), **אני** and **הגדרות** (D7)
- one photo flow from the header (D8)
- the look (D9), where the bar hides (D10), and the screens a tab opens (D11)

**Out:**
- The session: its cards, help and the results screen keep their layout and behaviour. The theme's shared
  colours reach them; the font stays the phone's own, as everywhere (R13).
- New options that don't exist today (dark mode, text size, interface language).
- The tutor's screens (invite a student, a student's words) keep their look; only their entry moves (D7).
- Sign-in, onboarding and enrolment.
- A new learner's first day: its own phase.
- Counting results (taps to start, sessions started): too few users.
- Changing what an option does. **The one exception is the photo flow** (D8), which Victor added in the chat.
- A prep with no photo (R2): a known gap, to fix if learners ask for it.

---

## 1. Decisions

### D1. The bar

Four tabs along the bottom, right to left: **תרגול · מילים · אני · הגדרות**, each with a line icon (play,
open book, person, gear) and its name. The active tab is blue with a pale blue pill behind its icon; the others
are grey. The bar shows on these four tabs only (D10).

A reminder's tap (`/?start=reminder`, phase 52) opens **תרגול** and acts as today.

### D2. The header

Every tab has the same header row, and no screen title on **תרגול** (R3):

- **Right:** the language, as a text chip with ▾. It is today's switcher: the other enrollments, then
  **הוספת שפה**, which opens enrolment.
- **Left:** two plain line icons, no circles:
  - **translate** (a magnifier): opens today's translate screen
  - **photo** (a camera): opens the photo flow (D8)

There is no homework-prep entry of its own: a prep starts from a photo (R2).

### D3. תרגול: one card at a time

The tab shows one large card. The others wait behind it as a stack: the edges of two more cards show under its
bottom edge, and dots below the stack show how many there are and which is on top (the current one long and
blue). Swiping the top card sideways brings the next; swiping back returns.

- **Order:** phase 57's (`homeOrder`): targets with work owed today, nearest date first; then My words; then
  targets done for today or resting. A target on its date is first.
- **The card's button** starts or resumes that path, exactly as each card's button does today, including the
  seed session, "preparing", the retry after a failed create, and skip.
- **Tapping the card** outside its button opens the target's screen, as today.
- **A pending tutor invitation** shows above the stack until it is answered *(my call; it is on home today)*.
- **No enrollment:** the stack's place holds one card with today's **התחלת לימוד שפה** *(my call)*.
- Everything else that sits on home today moves: translate and photo to the header (D2), new prep to the photo
  flow (D8), vocabulary to **מילים** (D6), the profile link and the students list to **אני** (D7).

### D4. The card

Every card has a blue header across its top and a white body (`countdown-options.html` option 1,
`band-all-cards.html` option A). Blue for every kind (R8).

**The header:** a gradient from `#3B5BDB` to `#5B7BF0`, with a faint white circle in one corner. In it:

- the kind's icon and name, small and pale: **בוחן**, **שיעורי בית**, **המילים שלי**
- the big line, in white, heavy:
  - a target: the days left as a large number with **ימים**; **מחר** for one day; **היום** on the date
    (phase 57's countdown wording)
  - My words: the number of words due for review; with none due, the number saved; for the seed, its count
    (today's `myWordsLine` values)
- a small pale line under it: a target's date (**יום ו׳, 23 באוקטובר**); My words' meaning of the number
  (**מילים מחכות לחזרה**, or today's saved and seed labels)
- a target's fuse (D5)

**The body**, below the header, keeps phase 57's lines and states:

- **owed:** **היום** with "k מתוך M מילים" and its bar; **מוכנות** with its percentage and bar; the button
- **done for today:** the green **כל הכבוד! סיימת להיום. נתראה מחר**, the extra words when there are any, the
  readiness bar
- **rest day:** phase 57's rest line, the readiness bar
- **the date itself** (`due_today`): phase 57's D10, which Victor ruled: **בהצלחה!**, the final readiness, and
  the optional **חזרה אחרונה**. No today line. (`urgency-combined.html` drew this card with a today line and
  **לתרגל עכשיו**; that was a sketch of the urgency marks, not a change to D10.)
- **My words:** today's line and states

**The button** says **לתרגל עכשיו** on every card with work owed, My words included (R3); **לתרגל עוד** on a
target done or resting, and **חזרה אחרונה** on the date, as today. It is solid blue when pressing it is the
thing to do now, and pale blue with blue text otherwise *(my call: phase 57 filled only the first card's
button, but now only one card is in view)*:

- **solid:** a target with work owed; a target on its date below 100% readiness (phase 57 D10); My words
  whenever its button starts or resumes a session (the seed included)
- **pale:** a target done for today or resting; a target on its date at 100%; My words while preparing

### D5. Urgency: the fuse and the "not ready" line

Both from `urgency-combined.html`, for targets only (R9).

**The fuse** is a thin line at the bottom of the header, always there. It shows the share of the prep's time
still left: `days_left / (due_on − created_on)`, between 0 and 1, with a round tip at its end.

- Normally white on the blue.
- In the **last two days** (`days_left ≤ 1`: tomorrow and the date itself) it turns amber, its tip glows and
  gently pulses, and a label under it reads **הזמן שנשאר** with **יום אחד** or **היום**.

**The "not ready" line** appears under the header in those same two days, only while some of the target's words
are not ready (`ready_count < word_count`). It is a pale amber strip with a warning icon:

- **הבוחן מחר ו-3 מילים עוד לא מוכנות. עוד תרגול אחד יעזור.**
- homework, and the date itself, change the subject and the day: **שיעורי הבית היום ו-2 מילים עוד לא
  מוכנות.** One word reads in the singular. On the date the line ends **חזרה אחרונה תעזור.** instead, to
  match the card's button *(my call)*.

Once every word is ready, the line is replaced by a green **כל המילים מוכנות לבוחן ✓** (**לשיעורי הבית** for
homework), and the fuse still glows: the time is short, but nothing is missing.

**The stack's dots:** a card in its last two days that is not on top shows as an amber dot.

**The wire:** the fuse needs the day the prep started. `targets.created_at` exists, but a target's summary
does not carry it. `TargetSummary` gains `created_on`, the learner day (ADR 0013) of `created_at`. It is a new
field the app reads; whether older clients need `API_LEVEL` raised is ADR 0012's call, and an added field
normally needs none.

### D6. מילים

Today's vocabulary screen, as a tab, under the header (`style-a-all-screens.html`):

- the title **המילים שלי** with the count beside it
- the level filters as pills (**הכל**, then the five levels), the selected one blue
- the words in a white grouped list: the word, its meaning under it, its level as a pale blue tag
- removing the words in a filter, a word's screen and the question types screen, as today

**No photo imports wait here.** Today's home photo card (working, ready, failed, several) and the imports list
go away: the photo flow waits for its photos to be read and leaves nothing half-done (R12). An unreviewed
import left by an older app, or by a flow the phone killed, is not shown anywhere; it saves no words
*(my call)*.

### D7. אני and הגדרות

The profile screen is split in two tabs (`four-tabs.html`, then `style-a-all-screens.html`; Victor: "It
looks good"):

- **אני**, who you are and who you learn with:
  - an initial in a pale blue circle, the name, the username
  - today's profile fields *(my call: age, native language and the rest move here as they are)*
  - **השפות שלי**: the enrollments, then **+ הוספת שפה**
  - **המורים שלי**: the tutors, and ending one, as today
  - **הוראה**: **התלמידים שלי** (today's students list, from home), then **+ הזמנת תלמיד/ה**
- **הגדרות**, how the app behaves:
  - **תזכורות**, with a short summary of the setting, opening today's reminders screen
  - **אודות**, with the version, opening today's About screen
  - **יציאה**, in red, in a group of its own

### D8. One photo flow

Victor: "The learner can add new words by adding pictures. After it was processed and he marked the words, the
app asks what to do with the new words. This way we have only a single flow for adding from pictures, and it
is always available in the header." (`photo-flow.html`.)

1. **Photos:** **תמונות של רשימת המילים**: take or pick several, as the wizard's photos step today.
2. **Reading**, then **mark the words:** the learner waits on the reading, in the flow, as in the wizard today
   (**קוראים את התמונות…**); then today's review (**המילים מהתמונות**: untick a word, pick another meaning).
3. **מה לעשות עם המילים החדשות?**, a list of choices:
   - **להוסיף למילים שלי**: saved, as photo import saves today; back with today's "N מילים נשמרו"
   - **הכנה חדשה לבוחן** and **הכנה חדשה לשיעורי בית**: on to the wizard's **עוד מילים** step, then
     **באיזה תאריך?**, then done; back to **תרגול** with the new card in its place in the order
   - **או להוסיף להכנה קיימת**: each active target (its kind, countdown and word count). The words join it
     *(my call: then back to that target's screen)*.

The flow is a full screen with a ✕ and no bar. It is built on the wizard's machinery (R12): leaving with
photos or words picked asks first (**לצאת בלי לשמור?**), and leaving discards the flow's imports, as the wizard
does today, whichever way it is left.

**What it replaces:** home's **מילים מתמונה** and the imports list and review screens behind it, the wizard's
entry from home (its kind and photos steps, now chosen at the end), and the target screen's **מילים מתמונות**
mode. The target screen keeps **הוספת מילים** and **שינוי התאריך**.

**The known gap (R2):** a prep can no longer start without a photo, for example from a dictated list. Victor:
"The gap is real, but it's better to solve if we hear complaints."

### D9. The look

Option A, "clean and calm" (R5), on every screen in scope:

- **Font:** the phone's own, as today, everywhere (R13). The mockups' Heebo is not used: the look comes from
  the colours, the cards and the blue header.
- **Colours** (theme tokens, today's names where they exist):
  - background `#F6F7FB`, surface white, text `#101828`, muted `#667085`
  - primary `#3B5BDB` (unchanged), primary surface `#EEF2FB`, progress green `#12B76A`
  - the header gradient `#3B5BDB` → `#5B7BF0`
  - amber `#F79009` / `#FDB022`, its surface `#FFFAEB` and text `#93370D`; danger `#D92D20`
- **Cards:** white, radius about 20, no border, a soft two-layer shadow (elevation on Android).
- **Lists:** white grouped blocks, radius 16, hairline separators, a small grey label above each group.
- **Buttons:** primary solid blue, radius 14; secondary pale blue with blue text.
- **Large numbers** carry what matters: the countdown, the counts.
- **Full screens** (translate, the photo flow): a title, a ✕, no bar.

Every value above comes from the approved mockups; the builder may round them to the theme's scales.

### D10. Where the bar shows

On the four tabs only. Everything else opens over the tabs without it, with a back arrow or a ✕ *(my call)*:

- the session and its results (Victor: during a session "we should not show any options, we want the learner
  to be focused")
- translate and the photo flow
- the screens a tab opens: a target, a word, question types, the imports list, reminders, About, a student's
  words, inviting a student
- sign-in, onboarding and enrolment

### D11. The screens a tab opens

The one-pager put them in ("translate, photo import, profile, reminders and About follow the concept too",
not struck), and Done 2 names targets. So the target screen, a word's screen, question types, the imports
list, reminders, About, translate and the wizard's remaining steps take the concept's parts:

- a top row with a back arrow (or ✕ for a flow) and the screen's title
- content in white cards and grouped lists (D9), buttons as D9's two kinds
- their behaviour, texts and testIDs unchanged

The tutor's screens (a student's words, inviting a student), sign-in, onboarding and enrolment are out: they
take the theme's colours and nothing else.

---

## 2. Testing

- **Core:** `TargetSummarySchema` accepts and requires `created_on` as a learner day.
- **Server (integration):** a target's summary carries `created_on`, the learner day of its creation in the
  learner's zone.
- **App (unit):**
  - the fuse: the share left, clamped; white before the last two days, amber in them
  - the "not ready" line: shown only when `days_left ≤ 1` and not every word is ready; its text for exam and
    homework, tomorrow and today, one word and several; the green ready line otherwise
  - the stack: phase 57's order; the dots; an amber dot for an urgent card not on top
  - the button: its label and its solid or pale look per state
  - the photo flow's last step lists the three choices and each active target
- **e2e:**
  - every spec that starts from a home button moves to the tabs or the header: translate, vocabulary, photo
    import, new target, profile, reminders. Each kept control keeps its testID; the tabs, the header icons and
    the stack get new ones.
  - new: moving between the four tabs; the header's translate and photo; the photo flow to My words, to a new
    prep and to an existing one; the "not ready" line on a target due tomorrow
- **Bots and the day simulation:** they call the API, not the screens; unchanged unless a spec says otherwise.

---

## Left for Victor

1. After the merge, once the release reaches the phone (About shows the version), the phone check on
   Android: the swipe between cards, the fuse's glow, and the shadows. Anything off is a follow-up PR.

## Rulings

Victor, 2026-10-18, in the chat and the mockups:

- **R1. The bar:** four tabs, **תרגול · מילים · אני · הגדרות**. He chose four tabs with translate (B) over three,
  then added **הגדרות**; translate later moved to the header (R2).
- **R2. The header:** translate and photo, on every tab (option 3, over two buttons on home and a translate
  box). No homework-prep icon: prep starts from a photo, and a prep without one is a known gap, solved if
  learners ask.
- **R3. תרגול has no title;** "the cards themselves tell the story". Every card's button says **לתרגל
  עכשיו**, "just as for the test".
- **R4. One photo flow** that asks at the end what to do with the words: My words, a new exam prep, a new
  homework prep, or (accepted when offered) a prep already open.
- **R5. The look is A, "clean and calm",** over B (bold and friendly), C (warm and focused), A2–A4, D (glass),
  E (rings) and its eight colourings, F (bold blocks), and the layouts G (road), H (one thing), I (week) and N
  (bento). He liked D and E on the way and came back to A: "the clean one".
- **R6. One card at a time, as a stack** (option 3), over the next card peeking in and names on top.
- **R7. The card's blue header** (option 1), over a calendar page, the days counted out and a ring; "the test
  in 5 days" was "too plain".
- **R8. Blue for every card** (A), over a colour per kind, "but it's good to have some urgency mark for tests
  and homeworks".
- **R9. Urgency is the fuse and the "not ready" line together** (5 + 6), over a tag, a warm header, an amber
  outline, a bookmark and a live dot. It starts in the last two days.
- **R10. The session stays out;** the bar and options hide there.
- **R11. The split of אני and הגדרות** as drawn, approved with the look ("It looks good").
- **R12. The photo flow waits in the flow** while the photos are read; leaving drops them (builder check,
  question 1). Chosen over leaving and finishing later from a banner on **מילים**, one photo at a time.
- **R13. The phone's own font everywhere** (builder check, question 2), over Heebo: Heebo has no Russian
  letters, and the session would either need it too or keep a second font.

### My calls

- D3: the invitation above the stack; the no-enrollment card.
- D4: the button solid when pressing it is the thing to do now, pale otherwise; the date's wording kept from
  phase 57 D10.
- D5: on the date, the "not ready" line ends **חזרה אחרונה תעזור.**
- D6: an unreviewed import left behind is not shown.
- D7: the profile fields move to **אני** as they are.
- D8: adding to an existing prep returns to that prep's screen.
- D10: screens opened from a tab cover the bar and have a back arrow.
