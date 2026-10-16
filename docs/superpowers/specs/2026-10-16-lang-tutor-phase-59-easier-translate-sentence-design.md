# Phase 59 — An easier translate-sentence card

- **Status:** Victor said "go till PR" on 2026-10-16 after reading it: approved, implemented inline on branch `phase-59-easier-translate`.
- **Date:** 2026-10-16
- **Source:** `drafts/2026-10-16-easier-translate-sentence-one-pager.md` (main checkout), and the
  brainstorming that followed it on 2026-10-16.
- **Builds on:** phase 56 (help on sentence translation, help is a miss), phase 27 (the sentence
  cards and their generation), phase 39 (the four skills a gloss's memory keeps).
- **Touches:** the generation prompt's `translate` task and its validation, the question's stored
  shape, the judged-answer request, the session service's grading, the app's sentence-translation
  card, prompt evals, e2e.

---

## Goal

The sentence-translation card shows a Hebrew sentence and asks for all of it in Italian. Victor
knows the word being practised but not the rest of the sentence, which the model writes freely from
everyday Italian: *"Prima studiamo, poi giochiamo."* for *poi*, *"Ci sono molte cose da fare
oggi."* for *ci sono*. Twice in his last five he typed only the target, *poi*, because the rest was
out of reach, and that is graded wrong like a blank. The card tests the words around the target,
which he was never taught, more than the target.

This phase makes the sentence one he can mostly build, and lets him look up the words he can't.

**Done means** (Victor):

1. On Victor's phone: he finishes sentence-translation cards without giving up, and the sentences
   read as something he can follow.
2. Automated tests and the prompt evals prove it works as designed (§2).
3. `npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e` and `npm run eval` pass.

## Scope

**In:** the model is told to build the sentence from the learner's own words as much as it can, and
to keep it short (D1); each Hebrew word on the card can be tapped to show the Italian the answer
needs for it (D2, D3); a tap on the target is help, a tap on a word from the learner's list is a
miss on that word, any other tap is free, and every tap is recorded (D4, D5).

**Out** (the one-pager's list, and the talk):

- How a typed translation is judged: unchanged.
- When the card appears in a word's life: unchanged.
- Tapping on any other card (cloze, dictation and the rest).
- Sentences already generated and stored: not regenerated. A card from before this phase has no word
  map, so only its target can be tapped (D3).
- A fixed list of "very common" words, or any hard count of words from outside the learner's list.
  Victor's ruling: the model tries to use the list as much as it can and keeps the sentence short,
  and the tap covers whatever else it uses.
- The bots and the day simulation, which do not model taps.

---

## 1. Decisions

### D1. Generation: the learner's words, and short

The `translate` task (`domain/distractors.ts`) changes in two ways.

- **The learner's words.** Every `translate` item's request carries the enrollment's
  **practised** words: entries of the list with at least one `gloss_memory` row, each as its
  Italian form and its Hebrew meaning. A saved word not yet practised is not sent. The rule tells
  the model to build the Italian translation from those words as much as it can, using whatever
  form of each the sentence needs, and to use other words only where the sentence cannot do without
  them, keeping those simple. The words go in the request once, not once per item.
  *Builder's call:* the cap when a list is large (Victor's has 13 words; send at most the 200 most
  recently practised, say), and the exact wording, which the evals decide.
- **Short.** The Hebrew sentence is 3–5 words: `TRANSLATE_MAX_WORDS` goes from 10 to 5, and the
  rule's wording says short. Validation counts as today, on the Hebrew sentence, and refuses a
  longer one as it does now.

Nothing is checked about how many list words the sentence used. That is the evals' job (§2), not a
validation rule.

### D2. Generation: the word map

For a tap to show "the Italian the answer needs", the model has to say which Italian goes with each
Hebrew word. The `translate` item's answer gains a **word map**: for each word of the Hebrew
sentence, in order, the Italian words of the reference translation that render it, exactly as
written there. A Hebrew word with no Italian of its own (for example, a pronoun Italian leaves out)
maps to nothing and cannot be tapped.

Each map entry that renders one of the learner's practised words also names it (by the key it was
sent with), so the server knows which list word a tap was on (D5).

Validation, after today's checks pass:

- an entry's Italian must appear in the reference translation; an entry whose Italian does not is
  dropped, and that Hebrew word cannot be tapped;
- an entry naming a word that was not sent loses the name and stays tappable as a free word;
- the target's Hebrew words are every word the `sentence_mark` span (phase 27) touches, whatever the
  map says about them; when the mark is null, the map entry whose Italian is the reference's gap
  takes its place, and with neither, no word is the target and only help reveals it (*my call*);
- any other entry whose Italian overlaps the reference's gap is dropped, so a free tap can never
  show the answer (*my call*: the mark and the map come from two calls and can disagree, most
  likely on a multi-word target such as *ci sono*).

A bad map never refuses the card: the card still works, with fewer words tappable. *Builder's
call:* how a Hebrew word is cut (on spaces, with Hebrew's attached prefixes left on the word, as
the learner sees it), and how the map is stored on the question (a nullable column holding the
spans, the Italian and the gloss id where there is one).

### D3. The card

On a sentence-translation card, every Hebrew word that has a map entry, and the target, can be
tapped before the answer is sent. A tap shows that word's Italian, exactly as the reference writes
it (*mangiamo*, not *mangiare*), beside or under the word, and it stays shown until the card ends.
Tapping again does nothing more.

- **The target** works as phase 56's help on this card: a tap sets the card's help state, and the
  word shown is the target as help reveals it. Pressing help afterwards goes on revealing from
  there. *Builder's call:* whether the tap reveals the whole target at once or acts as one help
  press. The whole word is what Victor described.
- **A card from before this phase** (no map) has only its target tappable.
- After the answer is sent, the taps are shown as they were, and the card's reference line is shown
  as today.

The highlighted target, the help button, the banner and the judging are unchanged.

### D4. What a tap costs

| Tapped word | Shows | Grade |
|---|---|---|
| The target | the target's Italian | the card is `helped`: phase 56's miss, written productive Again |
| A word from the learner's list, practised (D2 named it) | its Italian | a miss on **that** word: written productive Again on its gloss, as if it had been asked and missed |
| Any other word | its Italian | none |

A list word's miss counts in that word's **memory and progress**, so it comes back sooner and its
level drops as any missed word's does, and in `dayState`. It does **not** count in the session's
score or the results' missed list, which describe the cards answered (R5). It has no answer row of
its own, so the evidence the session's grading reads must take it in alongside the card's answer.
A list word's miss is written whatever the card's own verdict, and only once per word per card,
however often it is tapped. A word tapped on two cards in one session takes a miss for each, as
two missed cards would. *Builder's call:* whether a list word's miss goes through the same grading
path as a card's (preferred, so `dayState`, the event log and `reached_on` read it the same way).

### D5. Recording, and the wire

- `JudgedAnswerRequestSchema` gains an optional `tapped`: the indexes of the Hebrew words tapped,
  in the order of the first tap of each. It is optional, so `API_LEVEL` stays as it is (ADR 0012)
  and the app ships after the server. A target tap also sends `helped: true`, as help does.
- The question's response gains the word map's spans and Italian, so the app can show them; never
  the gloss ids.
- The answer stores the taps, so a session's taps can be read back: which words, on which card,
  and which of them were list words that took a miss. Victor wants derived state recorded where it
  can be traced (phase 39). *Builder's call:* a column on `answers` or a table of its own.
- `answer_judged` logs the count of taps and the list words that took a miss.
- A replayed judged answer writes no second miss.
- Taps belong to the card, not the try (*my call*). A phase 34 second try sends every tap so far;
  a target tap first made on the second try makes it a helped second try (phase 56: it resolves
  `wrong`); a list word's miss is still written once per card.
- A list word's miss reaches memory when the session's grades do, at its end, so it shapes later
  sessions and never the one it was tapped in (*my call*).

---

## 2. Testing

- **Domain:** the translate rule carries the practised words and the 3–5 word length; a 6-word
  Hebrew sentence is refused; the word map's validation drops an entry whose Italian is not in the
  reference, strips an unknown word key, and never refuses the card.
- **Core / server (integration):** a judged answer with `tapped` stores the taps; a target tap
  grades as a phase 56 helped answer; a tapped practised word gets written productive Again on its
  own gloss, once, whatever the card's verdict; a tap on an unnamed word grades nothing; a replay
  writes no second miss; a question from before this phase (no map) is served and answered as
  today.
- **App:** the tappable words follow the map; a tap shows the exact Italian; the target tap sets
  help; the request body carries `tapped` in order; a card with no map has only the target
  tappable.
- **Prompt evals:** the `translate` cases gain a learner list (Victor's 13 Italian words is a
  realistic size). Each generated sentence is scored for length (3–5 Hebrew words, always) and for
  the share of the Italian answer's content words that come from the list, which must clear a
  threshold set from the first runs. Diff the CI eval report against master per row: a rule on the
  translate task can bleed into the other tasks in the same call.
- **e2e:** on the sentence-translation spec, tap a non-target word and see its Italian, tap the
  target and see help's state, answer, and check the body sent.
- **Bots and the day simulation:** unchanged; they send no `tapped`.

---

## Rulings

- **R1 (Victor, brainstorming).** "Very common words" is not defined and there is no limit on
  words from outside the list: the model uses the learner's list as much as it can and keeps the
  sentence short.
- **R2 (Victor).** A tap shows the exact form the answer needs, not the dictionary form.
- **R3 (Victor).** A tap on a word the learner has already met records a miss on that word too.
- **R4 (Victor).** "Practised at least once" is what makes a list word count as known.
- **R5 (Victor, after the builder check).** A tapped list word's miss reaches its memory and
  progress, not the session score or the missed list.
- **R6 (planning).** The word map is asked of the context call's `mark` task, not the batch: that
  call already reads the Hebrew and its reference after the batch, a failure there costs one card's
  mark and never the session, and the batch's schema is the one that once hung on new fields. The
  learner's words go to both calls. Stored as `questions.words`; taps in `answer_taps`.
- **R7 (planning, corrected in Task 3).** Taps also travel on a give-up: giving up after looking a
  word up is the likeliest case of a list word's miss. A sentence translation is given up through
  the judged route with an empty text, never a next-step pass, so that route's `tapped` covers it.
